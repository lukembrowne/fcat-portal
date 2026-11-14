#!/usr/bin/env node
/**
 * One-off correction: QA "ventana válida" values stored one hour late.
 *
 * Until 2026-11-09, `toggleSetupTag` formatted the tagged photo's time with the
 * server's local getters. Production runs TZ=America/New_York, which matches
 * Ecuador (UTC-5) only in winter, so every window tagged from a photo taken
 * during US daylight saving (mid-March → early November) was saved +1 h.
 *
 * A value is corrected ONLY when it equals a photo tagged for that end
 * ('deployment' → valid_start, 'retrieval' → valid_end) formatted in New York
 * time, AND that differs from the same photo in Ecuador time. A hand-typed
 * value, a winter tag, or a tag removed later can't satisfy that, so they are
 * left alone and listed as "untouched".
 *
 * DRY RUN BY DEFAULT. Self-contained (only better-sqlite3) so it can be piped
 * into the prod container without a deploy:
 *
 *   # dry run — prints the plan as JSON, writes nothing
 *   ssh digitalocean "cd /root/opt/fcat-portal && \
 *     docker compose exec -T portal node --input-type=module -" \
 *     < scripts/fix-dst-valid-window.mjs > dst-fix-plan.json
 *
 *   # apply (take a backup first — see the db-backup-restore skill)
 *   ssh digitalocean "cd /root/opt/fcat-portal && \
 *     docker compose exec -T -e FIX_APPLY=1 -e FIX_ACTOR=you@fcat-ecuador.org portal \
 *     node --input-type=module -" < scripts/fix-dst-valid-window.mjs > dst-fix-applied.json
 *
 * Applying runs one synchronous transaction; each UPDATE is guarded by the old
 * value (`AND valid_start = ?`) so a window edited after the plan was computed
 * is skipped and reported, never overwritten. The full before/after list goes to
 * stdout AND into the system_events row's `details`, so the change can be
 * reversed from the database alone.
 */

import { createRequire } from "node:module";

const NY = "America/New_York";
const EC = "America/Guayaquil";

/** "YYYY-MM-DDTHH:mm" of an instant in the given IANA zone. */
export function wallClock(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function captureMs(img) {
  if (img.exifTimestamp) {
    const t = Date.parse(img.exifTimestamp);
    if (Number.isFinite(t)) return t;
  }
  return img.fileModified ? img.fileModified * 1000 : null;
}

/**
 * Decide the correction for one deployment's window, given its tagged photos.
 * Pure — the tests drive it directly.
 * @returns {Array<{field, from, to, imageId} | {field, value, untouched: true, reason}>}
 */
export function planDeployment(dep, taggedImages) {
  const out = [];
  for (const [field, tag, value] of [
    ["valid_start", "deployment", dep.validStart],
    ["valid_end", "retrieval", dep.validEnd],
  ]) {
    if (!value) continue;
    const photos = taggedImages
      .filter((i) => i.setupTag === tag)
      .map((i) => ({ ...i, ms: captureMs(i) }))
      .filter((i) => i.ms != null);
    if (photos.some((p) => wallClock(p.ms, EC) === value)) continue; // already right
    const hit = photos.find((p) => wallClock(p.ms, NY) === value && wallClock(p.ms, NY) !== wallClock(p.ms, EC));
    if (hit) {
      out.push({ field, from: value, to: wallClock(hit.ms, EC), imageId: hit.id });
    } else {
      out.push({
        field,
        value,
        untouched: true,
        reason: photos.length
          ? "no coincide con la foto etiquetada (¿editada a mano?)"
          : `ninguna foto etiquetada como '${tag}'`,
      });
    }
  }
  return out;
}

export function plan(db) {
  const deps = db
    .prepare(
      `SELECT id, name, valid_start AS validStart, valid_end AS validEnd
         FROM biochoco_deployments
        WHERE valid_start IS NOT NULL OR valid_end IS NOT NULL
        ORDER BY name`,
    )
    .all();
  const tagged = db.prepare(
    `SELECT id, setup_tag AS setupTag, exif_timestamp AS exifTimestamp, file_modified AS fileModified
       FROM biochoco_images WHERE deployment_id = ? AND setup_tag IS NOT NULL`,
  );
  const changes = [];
  const untouched = [];
  let alreadyCorrect = 0;
  for (const d of deps) {
    const decisions = planDeployment(d, tagged.all(d.id));
    const set = Number(Boolean(d.validStart)) + Number(Boolean(d.validEnd));
    alreadyCorrect += set - decisions.length;
    for (const x of decisions) {
      const row = { deploymentId: d.id, name: d.name, ...x };
      (x.untouched ? untouched : changes).push(row);
    }
  }
  return { changes, untouched, alreadyCorrect };
}

export function apply(db, changes, actor) {
  const nowS = Math.floor(Date.now() / 1000); // Drizzle timestamp columns are SECONDS
  const stmts = {
    valid_start: db.prepare(
      "UPDATE biochoco_deployments SET valid_start = ?, updated_at = ? WHERE id = ? AND valid_start = ?",
    ),
    valid_end: db.prepare(
      "UPDATE biochoco_deployments SET valid_end = ?, updated_at = ? WHERE id = ? AND valid_end = ?",
    ),
  };
  const applied = [];
  const skipped = [];
  db.transaction(() => {
    for (const c of changes) {
      const r = stmts[c.field].run(c.to, nowS, c.deploymentId, c.from);
      (r.changes === 1 ? applied : skipped).push(c);
    }
    db.prepare(
      `INSERT INTO system_events (occurred_at, event_type, source, severity, actor_email, project_id, target_type, summary, details)
       VALUES (?, 'fix_dst_valid_window', 'camera-trap', 'info', ?, 'camera-trap', 'deployment', ?, ?)`,
    ).run(
      nowS,
      actor,
      `Corrección DST de ventanas QA: ${applied.length} valores −1 h`,
      JSON.stringify({ applied, skipped }),
    );
  })();
  return { applied, skipped };
}

function main() {
  const require = createRequire(`${process.cwd()}/`);
  const Database = require("better-sqlite3");
  const doApply = process.env.FIX_APPLY === "1";
  const db = new Database(process.env.FIX_DB || "data/portal.db", {
    readonly: !doApply,
    fileMustExist: true,
  });
  const p = plan(db);
  const result = { mode: doApply ? "apply" : "dry-run", ranAt: new Date().toISOString(), ...p };
  if (doApply) {
    if (!process.env.FIX_ACTOR) throw new Error("FIX_ACTOR (email) is required with FIX_APPLY=1");
    Object.assign(result, apply(db, p.changes, process.env.FIX_ACTOR));
  }
  db.close();
  process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  console.error(
    `${result.mode}: ${p.changes.length} to correct, ${p.alreadyCorrect} already correct, ${p.untouched.length} untouched` +
      (doApply ? ` → applied ${result.applied.length}, skipped ${result.skipped.length}` : ""),
  );
}

if (!process.env.VITEST) main();
