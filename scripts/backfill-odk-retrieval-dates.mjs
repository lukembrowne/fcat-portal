#!/usr/bin/env node
/**
 * One-off: copy ODK retrieve_sensors dates into deployments whose `date_end`
 * is still empty.
 *
 * Linking a deployment to ODK used to happen only when its Drive folder was
 * first discovered — at installation, before the retrieval form exists — so
 * retrieval dates never reached `date_end` on their own. The nightly refresh
 * now re-links (`relinkIncompleteOdkDeploymentsInternal`); this catches up the
 * backlog without waiting for a deploy and a night.
 *
 * Same rules as the portal: fills ONLY an empty date_end, takes the latest
 * retrieval per deployment, matches names the way `matchOdkDeploymentsInternal`
 * does, and marks the row ODK-sourced unless it was edited manually.
 *
 * Dry run by default; pass --apply to write. Run inside the container:
 *   docker compose exec -T portal node scripts/backfill-odk-retrieval-dates.mjs [--apply]
 */

import Database from "better-sqlite3";

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.DB_PATH || "data/portal.db";
const BIOCHOCO_PROJECT_ID = "8";

const { ODK_CENTRAL_URL, ODK_CENTRAL_EMAIL, ODK_CENTRAL_PASSWORD } = process.env;
if (!ODK_CENTRAL_URL || !ODK_CENTRAL_EMAIL || !ODK_CENTRAL_PASSWORD) {
  console.error("ODK_CENTRAL_URL / _EMAIL / _PASSWORD must be set");
  process.exit(1);
}

const normalize = (s) => String(s).toLowerCase().replace(/[\s_\-.]+/g, "").trim();

const session = await fetch(`${ODK_CENTRAL_URL}/v1/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: ODK_CENTRAL_EMAIL, password: ODK_CENTRAL_PASSWORD }),
});
if (!session.ok) throw new Error(`ODK login failed: ${session.status}`);
const { token } = await session.json();

const res = await fetch(
  `${ODK_CENTRAL_URL}/v1/projects/${BIOCHOCO_PROJECT_ID}/forms/retrieve_sensors.svc/Submissions?$top=10000`,
  { headers: { Authorization: `Bearer ${token}` } },
);
if (!res.ok) throw new Error(`ODK retrieve_sensors fetch failed: ${res.status}`);
const { value: submissions } = await res.json();
if (!Array.isArray(submissions)) throw new Error("ODK response carried no submissions");

const latest = new Map();
for (const sub of submissions) {
  const sel = sub.site_selection ?? {};
  const depId = sel.deployment_id ?? sub.deployment_id;
  const date =
    sub.retrieval_info?.retrieval_date ?? sel.fecha_recuperacion ?? sub.fecha_recuperacion;
  if (!depId || !date) continue;
  const key = normalize(depId);
  const day = String(date).slice(0, 10);
  if (!latest.has(key) || day > latest.get(key)) latest.set(key, day);
}

const db = new Database(DB_PATH);
const open = db
  .prepare("SELECT id, name FROM biochoco_deployments WHERE date_end IS NULL ORDER BY name")
  .all();
const update = db.prepare(`
  UPDATE biochoco_deployments
     SET date_end = ?,
         metadata_source = CASE WHEN metadata_source = 'manual' THEN metadata_source ELSE 'odk' END,
         updated_at = ?
   WHERE id = ? AND date_end IS NULL`);

const fills = open
  .map((d) => ({ ...d, dateEnd: latest.get(normalize(d.name)) }))
  .filter((d) => d.dateEnd);

console.log(`ODK retrievals: ${submissions.length} · deployments without date_end: ${open.length}`);
for (const d of fills) console.log(`  ${d.name.padEnd(28)} → ${d.dateEnd}`);
console.log(`${fills.length} to fill, ${open.length - fills.length} have no retrieval in ODK.`);

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply to write.");
  process.exit(0);
}

// Drizzle timestamp columns hold Unix SECONDS.
const now = Math.floor(Date.now() / 1000);
let written = 0;
db.transaction(() => {
  for (const d of fills) written += update.run(d.dateEnd, now, d.id).changes;
})();
console.log(`\nWrote ${written} retrieval dates.`);
