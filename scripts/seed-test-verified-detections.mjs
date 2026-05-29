/**
 * Seed synthetic VERIFIED detections so the training-export can be exercised on
 * a dev DB that lacks enough real verified data.
 *
 * It does NOT invent images — it attaches new class-0 detections + verified
 * identifications to EXISTING images that have a Drive file id, so the export's
 * crop step actually downloads + crops real bytes. Species labels are synthetic.
 *
 * Distribution guarantees each species spans >= STRATIFY_MIN_DEPLOYMENTS (3)
 * deployments so it survives the val/test coverage guard.
 *
 * Idempotent + reversible: every row it writes is tagged model_version='SEED-TEST'.
 * Re-running cleans prior seed rows first. To remove entirely:
 *   node scripts/seed-test-verified-detections.mjs --clean
 *
 * Run inside the container (NEVER bare on the host while the dev container holds
 * the DB — macOS bind-mount corruption):
 *   docker compose exec -T portal node scripts/seed-test-verified-detections.mjs
 */
import Database from "better-sqlite3";

const TAG = "SEED-TEST";
const SPECIES = [
  "Cuniculus paca",
  "Dasyprocta punctata",
  "Leopardus pardalis",
  "Mazama americana",
];
// Well-stocked, non-excluded deployments (all have >100 downloadable images).
const DEPLOYMENTS = [111, 152, 137, 109, 147];
const PER_SPECIES_PER_DEP = 5; // → 25 examples/species across 5 deployments
const CLEAN_ONLY = process.argv.includes("--clean");

const db = new Database("data/portal.db");
db.pragma("busy_timeout = 5000");

const cleaned = db.transaction(() => {
  const di = db
    .prepare("DELETE FROM biochoco_identifications WHERE model_version = ?")
    .run(TAG);
  const dd = db
    .prepare("DELETE FROM biochoco_detections WHERE model_version = ?")
    .run(TAG);
  return { idents: di.changes, dets: dd.changes };
});

const removed = cleaned();
console.log(
  `[seed] cleaned prior seed: ${removed.dets} detections, ${removed.idents} identifications`,
);

if (CLEAN_ONLY) {
  console.log("[seed] --clean done.");
  db.close();
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000); // Drizzle timestamp = unix SECONDS

const insDet = db.prepare(
  `INSERT INTO biochoco_detections
     (image_id, job_id, bbox_x, bbox_y, bbox_width, bbox_height, detection_confidence, detection_class, model_version)
   VALUES (?, NULL, ?, ?, ?, ?, ?, 0, ?)`,
);
const insIdent = db.prepare(
  `INSERT INTO biochoco_identifications
     (detection_id, species, confidence, model_version, verification_status, corrected_species, verified_by, verified_at)
   VALUES (?, ?, ?, ?, 'verified', NULL, ?, ?)`,
);
const pickImages = db.prepare(
  `SELECT id FROM biochoco_images
     WHERE deployment_id = ? AND drive_file_id IS NOT NULL
     ORDER BY id LIMIT ?`,
);

const seed = db.transaction(() => {
  let total = 0;
  for (const dep of DEPLOYMENTS) {
    const need = SPECIES.length * PER_SPECIES_PER_DEP;
    const imgs = pickImages.all(dep, need);
    if (imgs.length < need) {
      console.warn(
        `[seed] dep ${dep}: only ${imgs.length} downloadable images (<${need}) — seeding fewer`,
      );
    }
    let k = 0;
    for (const sp of SPECIES) {
      for (let i = 0; i < PER_SPECIES_PER_DEP && k < imgs.length; i++, k++) {
        // Vary the box slightly so crops aren't identical.
        const bx = 0.2 + (i % 3) * 0.05;
        const by = 0.2 + (k % 4) * 0.05;
        const det = insDet.run(imgs[k].id, bx, by, 0.45, 0.45, 0.95, TAG);
        insIdent.run(det.lastInsertRowid, sp, 0.9, TAG, "seed-test@fcat-ecuador.org", now);
        total++;
      }
    }
    console.log(`[seed] dep ${dep}: created ${k} verified detections`);
  }
  return total;
});

const total = seed();
console.log(`[seed] created ${total} verified detections total`);

const summary = db
  .prepare(
    `SELECT idn.species, COUNT(*) examples, COUNT(DISTINCT i.deployment_id) deployments
       FROM biochoco_identifications idn
       JOIN biochoco_detections det ON det.id = idn.detection_id
       JOIN biochoco_images i ON i.id = det.image_id
      WHERE idn.model_version = ?
      GROUP BY idn.species`,
  )
  .all(TAG);
console.log("[seed] coverage (species → examples / deployments):");
for (const r of summary) {
  console.log(`  ${r.species}: ${r.examples} examples across ${r.deployments} deployments`);
}
db.close();
