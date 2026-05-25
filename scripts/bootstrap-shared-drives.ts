/**
 * Bootstrap the shared_drives registry from existing data.
 *
 * Discovers every Google Shared Drive currently backing BioChoco deployments,
 * registers one shared_drives row per distinct Shared Drive, counts each
 * drive's items (Drive API ground truth), and backfills
 * biochoco_deployments.shared_drive_id.
 *
 * Idempotent + re-runnable: INSERT OR IGNORE + `WHERE … IS NULL` guards.
 *
 * Run AFTER `node scripts/push-schema.mjs` (so the tables + FK column exist).
 *
 * Usage:
 *   npx tsx scripts/bootstrap-shared-drives.ts [--dry-run]
 *   docker compose exec portal npx tsx scripts/bootstrap-shared-drives.ts
 *
 * Requires env: GOOGLE_SERVICE_ACCOUNT_KEY (base64 JSON), CAMERA_TRAP_ROOT_FOLDER_ID.
 */

import dotenv from "dotenv";
// Load local dev env (no-op in Docker, where vars are injected by compose).
dotenv.config({ path: ".env.local" });

import Database from "better-sqlite3";
import path from "path";
import { google, type drive_v3 } from "googleapis";

const DRY_RUN = process.argv.includes("--dry-run");

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

/** Resolve the underlying Shared Drive ID + name for a folder ID. */
async function resolveDrive(
  folderId: string,
): Promise<{ driveId: string | null; name: string | null }> {
  const res = await drive.files.get({
    fileId: folderId,
    fields: "driveId, name",
    supportsAllDrives: true,
  });
  return { driveId: res.data.driveId ?? null, name: res.data.name ?? null };
}

async function getDriveName(driveId: string): Promise<string> {
  const res = await drive.drives.get({ driveId, fields: "name" });
  return res.data.name ?? "(sin nombre)";
}

async function countItems(driveId: string): Promise<number> {
  let count = 0;
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const res = await drive.files.list({
      corpora: "drive",
      driveId,
      q: "trashed = false",
      fields: "nextPageToken, files(id)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    count += res.data.files?.length ?? 0;
    pageToken = res.data.nextPageToken ?? undefined;
    pages++;
    if (pages % 25 === 0) console.log(`    …counted ${count} items so far`);
  } while (pageToken);
  return count;
}

async function startPageToken(driveId: string): Promise<string> {
  const res = await drive.changes.getStartPageToken({
    driveId,
    supportsAllDrives: true,
  });
  if (!res.data.startPageToken) throw new Error("no startPageToken");
  return res.data.startPageToken;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "shared-drive"
  );
}

async function main() {
  const envRoot = process.env.CAMERA_TRAP_ROOT_FOLDER_ID;
  if (!envRoot) throw new Error("CAMERA_TRAP_ROOT_FOLDER_ID not configured");

  const db = new Database(getDbPath());
  db.pragma("foreign_keys = ON");

  console.log(`Bootstrap shared_drives${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log(`DB: ${getDbPath()}`);
  console.log(`Env root folder: ${envRoot}`);

  // Sanity: tables must exist.
  const haveTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shared_drives'")
    .get();
  if (!haveTable) {
    throw new Error("shared_drives table missing — run `node scripts/push-schema.mjs` first");
  }

  // Map: rootFolderId → { sharedDriveId (slug), driveId }
  const rootToDrive = new Map<string, { slug: string; driveId: string }>();

  // 1. Resolve + register fcat-biochoco from the env root.
  const envResolved = await resolveDrive(envRoot);
  if (!envResolved.driveId) {
    throw new Error(
      `Could not resolve a Shared Drive ID for env root ${envRoot} — is it actually on a Shared Drive?`,
    );
  }
  console.log(`Env root resolves to Shared Drive ${envResolved.driveId}`);

  const upsertDrive = db.prepare(`
    INSERT OR IGNORE INTO shared_drives (id, drive_id, root_folder_id, name, status)
    VALUES (?, ?, ?, ?, 'registering')
  `);

  if (!DRY_RUN) {
    upsertDrive.run("fcat-biochoco", envResolved.driveId, envRoot, "FCAT-BIOCHOCO");
  }
  rootToDrive.set(envRoot, { slug: "fcat-biochoco", driveId: envResolved.driveId });

  // 2. Discover other Shared Drives via distinct ct_projects roots.
  const ctProjects = db
    .prepare("SELECT id, name, drive_folder_id FROM ct_projects WHERE drive_folder_id IS NOT NULL")
    .all() as { id: number; name: string; drive_folder_id: string }[];

  for (const ctp of ctProjects) {
    const root = ctp.drive_folder_id;
    if (rootToDrive.has(root)) continue; // already mapped (e.g. == envRoot)
    const resolved = await resolveDrive(root);
    if (!resolved.driveId) {
      console.warn(`  ⚠️  ct_project "${ctp.name}" root ${root} has no driveId — skipping`);
      continue;
    }
    // One shared_drives row per distinct driveId.
    const already = [...rootToDrive.values()].find((v) => v.driveId === resolved.driveId);
    if (already) {
      rootToDrive.set(root, already);
      continue;
    }
    const name = await getDriveName(resolved.driveId);
    let slug = slugify(name);
    // Ensure unique slug.
    let n = 1;
    while (db.prepare("SELECT 1 FROM shared_drives WHERE id = ?").get(slug)) {
      n++;
      slug = `${slugify(name)}-${n}`;
    }
    console.log(`  Discovered Shared Drive "${name}" (${resolved.driveId}) via ct_project "${ctp.name}"`);
    if (!DRY_RUN) upsertDrive.run(slug, resolved.driveId, root, name);
    rootToDrive.set(root, { slug, driveId: resolved.driveId });
  }

  // 3. Count + activate each registered drive.
  const distinctDrives = new Map<string, { slug: string; root: string }>();
  for (const [root, v] of rootToDrive) {
    if (!distinctDrives.has(v.driveId)) distinctDrives.set(v.driveId, { slug: v.slug, root });
  }
  for (const [driveId, info] of distinctDrives) {
    console.log(`  Counting items on ${info.slug} (${driveId})…`);
    const count = await countItems(driveId);
    const token = await startPageToken(driveId);
    console.log(`    ${info.slug}: ${count.toLocaleString()} items`);
    if (!DRY_RUN) {
      db.prepare(`
        UPDATE shared_drives
        SET reconciled_count = ?, changes_page_token = ?,
            last_reconciled_at = datetime('now'),
            last_full_reconcile_at = datetime('now'),
            last_health_check_at = datetime('now'),
            last_health_status = 'ok', status = 'active',
            updated_at = datetime('now')
        WHERE id = ?
      `).run(count, token, info.slug);
    }
  }

  // 4. Backfill biochoco_deployments.shared_drive_id by ct_project mapping.
  // Build ct_project_id → sharedDriveId(slug). Projects with a known root map
  // to that drive; everything else defaults to fcat-biochoco (the env root).
  const ctToSlug = new Map<number, string>();
  for (const ctp of ctProjects) {
    const mapped = rootToDrive.get(ctp.drive_folder_id);
    if (mapped) ctToSlug.set(ctp.id, mapped.slug);
  }

  if (!DRY_RUN) {
    const setSlug = db.prepare(`
      UPDATE biochoco_deployments SET shared_drive_id = ?
      WHERE ct_project_id = ? AND drive_folder_id IS NOT NULL AND shared_drive_id IS NULL
    `);
    for (const [ctId, slug] of ctToSlug) setSlug.run(slug, ctId);

    // Remaining unmapped rows (null ct_project or ct_project without a root) →
    // fcat-biochoco (they live on the env-root Shared Drive).
    db.prepare(`
      UPDATE biochoco_deployments SET shared_drive_id = 'fcat-biochoco'
      WHERE drive_folder_id IS NOT NULL AND shared_drive_id IS NULL
    `).run();
  }

  // 5. Final assertion: no deployment with a folder is left unmapped.
  const unmapped = db
    .prepare(
      "SELECT COUNT(*) AS n FROM biochoco_deployments WHERE drive_folder_id IS NOT NULL AND shared_drive_id IS NULL",
    )
    .get() as { n: number };
  console.log(`Unmapped deployments (folder set, drive null): ${unmapped.n}`);

  // 6. Print the resulting registry.
  const drives = db.prepare("SELECT id, drive_id, name, status, reconciled_count FROM shared_drives").all();
  console.table(drives);

  db.close();

  if (!DRY_RUN && unmapped.n > 0) {
    console.error("❌ Backfill incomplete — some deployments have no shared_drive_id.");
    process.exit(1);
  }
  console.log(`✅ Bootstrap ${DRY_RUN ? "(dry run) " : ""}complete.`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Bootstrap failed:", err);
  if (/shared drive membership|Shared drive not found/i.test(msg)) {
    console.error(
      "\nHint: the service account is not a MEMBER of the Shared Drive.\n" +
        "Folder-level sharing is not enough for capacity ops (drives.get /\n" +
        "files.list?corpora=drive / changes.list). Add the SA (client_email\n" +
        "from GOOGLE_SERVICE_ACCOUNT_KEY) as a Content Manager member of the\n" +
        "Shared Drive, then re-run. See docs/operations/shared-drive-provisioning-runbook.md.",
    );
  }
  process.exit(1);
});
