/**
 * Backfill biochoco_deployments.shared_drive_id by resolving each deployment's
 * folder to the Shared Drive it ACTUALLY lives in (Drive API `files.get` →
 * `driveId`), then matching that `0A…` id to a registered `shared_drives` row.
 *
 * Why per-folder (not per-project): a single camera-trap project (BioChoco) will
 * eventually span multiple Shared Drives via the fan-out. Mapping by project (as
 * scripts/bootstrap-shared-drives.ts does) would pin every deployment to ONE
 * drive and mis-route those whose folders live elsewhere. Resolving each
 * folder's real host drive stays correct no matter how the project is spread.
 *
 * The field-upload endpoint derives a deployment's `driveId` from this column;
 * until it's set the deployment is "not routable" and the uploader blocks it.
 *
 * Idempotent + re-runnable: only touches rows where shared_drive_id IS NULL.
 *
 * Usage:
 *   npx tsx scripts/backfill-deployment-shared-drives.ts [--dry-run] [--limit N]
 *   docker compose exec portal npx tsx scripts/backfill-deployment-shared-drives.ts
 *
 * Requires env: GOOGLE_SERVICE_ACCOUNT_KEY (base64 JSON). The SA must be a
 * Content Manager MEMBER of each Shared Drive (folder sharing isn't enough).
 */

import dotenv from "dotenv";
// Load local dev env (no-op in Docker, where vars are injected by compose).
dotenv.config({ path: ".env.local" });

import Database from "better-sqlite3";
import path from "path";
import { google, type drive_v3 } from "googleapis";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
})();

function getDbPath(): string {
  const dbPath = process.env.DB_PATH || "data/portal.db";
  return path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
}

function getDrive(): drive_v3.Drive {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

const drive = getDrive();

// Retry on transient Drive errors (mirrors withRetry in src/lib/drive-client.ts
// and scripts/bootstrap-shared-drives.ts).
const MAX_RETRIES = 6;

function isRetriableDriveError(err: unknown): boolean {
  const e = err as {
    code?: number;
    status?: number;
    message?: string;
    response?: { status?: number; data?: { error?: { errors?: Array<{ reason?: string }> } } };
    errors?: Array<{ reason?: string }>;
    cause?: { message?: string; errors?: Array<{ reason?: string }> };
  };
  const status = e?.code ?? e?.status ?? e?.response?.status;
  if (status === 429) return true;
  if (status != null && status >= 500 && status < 600) return true;
  if (status === 403) {
    const reason =
      e?.errors?.[0]?.reason ??
      e?.cause?.errors?.[0]?.reason ??
      e?.response?.data?.error?.errors?.[0]?.reason;
    if (reason === "userRateLimitExceeded" || reason === "rateLimitExceeded") return true;
    const msg = String(e?.message ?? e?.cause?.message ?? "");
    return /rate limit/i.test(msg);
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableDriveError(err) || attempt === MAX_RETRIES) throw err;
      const exp = Math.min(500 * 2 ** attempt, 32_000);
      const delay = Math.floor(exp / 2 + Math.random() * (exp / 2));
      console.log(`    (rate-limited on ${label}; retry ${attempt + 1} in ${delay}ms)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** The 0A… Shared Drive a folder lives in, or null (My Drive / not found). */
async function resolveDriveId(folderId: string): Promise<string | null> {
  const res = await withRetry(
    () => drive.files.get({ fileId: folderId, fields: "driveId", supportsAllDrives: true }),
    `files.get(${folderId})`,
  );
  return res.data.driveId ?? null;
}

interface DeploymentRow {
  id: number;
  name: string;
  drive_folder_id: string | null;
  upload_camera_folder_id: string | null;
  upload_audio_folder_id: string | null;
  upload_ibutton_folder_id: string | null;
}

async function main() {
  const db = new Database(getDbPath());
  db.pragma("foreign_keys = ON");

  console.log(`Backfill deployment shared_drive_id${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log(`DB: ${getDbPath()}`);

  // Registry: driveId (0A…) → slug.
  const driveRows = db
    .prepare("SELECT id, drive_id FROM shared_drives")
    .all() as { id: string; drive_id: string }[];
  const driveIdToSlug = new Map(driveRows.map((r) => [r.drive_id, r.id]));
  console.log(`Registered drives: ${driveRows.length}`);
  if (driveRows.length === 0) {
    throw new Error("No shared_drives registered — register them first (admin UI or bootstrap).");
  }

  // Deployments needing a drive: shared_drive_id null AND at least one folder ID.
  const rows = db
    .prepare(
      `SELECT id, name, drive_folder_id,
              upload_camera_folder_id, upload_audio_folder_id, upload_ibutton_folder_id
       FROM biochoco_deployments
       WHERE shared_drive_id IS NULL
         AND COALESCE(drive_folder_id, upload_camera_folder_id,
                      upload_audio_folder_id, upload_ibutton_folder_id) IS NOT NULL`,
    )
    .all() as DeploymentRow[];

  const targets = rows.slice(0, LIMIT);
  console.log(`Deployments to backfill: ${rows.length}${targets.length < rows.length ? ` (limited to ${targets.length})` : ""}`);

  const setSlug = db.prepare(
    "UPDATE biochoco_deployments SET shared_drive_id = ?, updated_at = datetime('now') WHERE id = ? AND shared_drive_id IS NULL",
  );

  let updated = 0;
  let noFolder = 0; // shouldn't happen given the WHERE, but be safe
  let noDriveId = 0; // folder resolved to My Drive / null
  const unregistered = new Map<string, number>(); // driveId → count (drive not in registry)
  const errors: { id: number; name: string; err: string }[] = [];

  let i = 0;
  for (const row of targets) {
    i++;
    const folder =
      row.drive_folder_id ??
      row.upload_camera_folder_id ??
      row.upload_audio_folder_id ??
      row.upload_ibutton_folder_id;
    if (!folder) {
      noFolder++;
      continue;
    }
    try {
      const driveId = await resolveDriveId(folder);
      if (!driveId) {
        noDriveId++;
        console.warn(`  ⚠️  ${row.name} (#${row.id}): folder ${folder} has no driveId (My Drive?) — skipping`);
        continue;
      }
      const slug = driveIdToSlug.get(driveId);
      if (!slug) {
        unregistered.set(driveId, (unregistered.get(driveId) ?? 0) + 1);
        console.warn(`  ⚠️  ${row.name} (#${row.id}): drive ${driveId} is NOT registered — skipping`);
        continue;
      }
      if (!DRY_RUN) setSlug.run(slug, row.id);
      updated++;
      if (i % 25 === 0 || i === targets.length) {
        console.log(`  …${i}/${targets.length} processed (${updated} set)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ id: row.id, name: row.name, err: msg });
      console.warn(`  ✖ ${row.name} (#${row.id}): ${msg}`);
    }
  }

  console.log("\n── Summary ──");
  console.log(`  set shared_drive_id:        ${updated}${DRY_RUN ? " (dry run — not written)" : ""}`);
  console.log(`  skipped (no driveId):       ${noDriveId}`);
  console.log(`  skipped (no folder):        ${noFolder}`);
  console.log(`  skipped (unregistered drv): ${[...unregistered.values()].reduce((a, b) => a + b, 0)}`);
  if (unregistered.size > 0) {
    console.log("  unregistered drives encountered (register these, then re-run):");
    for (const [driveId, count] of unregistered) console.log(`    ${driveId}: ${count} deployment(s)`);
  }
  console.log(`  errors:                     ${errors.length}`);

  // Remaining null rows after this pass (folder set, drive still null).
  const remaining = db
    .prepare(
      "SELECT COUNT(*) AS n FROM biochoco_deployments WHERE shared_drive_id IS NULL AND drive_folder_id IS NOT NULL",
    )
    .get() as { n: number };
  console.log(`  deployments still unrouted: ${remaining.n}`);

  db.close();
  console.log(`\n✅ Backfill ${DRY_RUN ? "(dry run) " : ""}complete.`);
  // Non-zero only on hard errors; unregistered/null are actionable warnings.
  if (errors.length > 0) process.exit(1);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Backfill failed:", err);
  if (/shared drive membership|Shared drive not found/i.test(msg)) {
    console.error(
      "\nHint: the service account must be a Content Manager MEMBER of each Shared Drive\n" +
        "(folder-level sharing is not enough). See docs/operations/shared-drive-provisioning-runbook.md.",
    );
  }
  process.exit(1);
});
