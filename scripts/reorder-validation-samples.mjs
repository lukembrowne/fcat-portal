/**
 * Backfill: decouple validation queue position from BirdNET score.
 *
 * WHAT WENT WRONG. `presentationOrder` permuted the drawn sample with the SAME
 * hash the draw used to select it — `(id + seed) * M mod P`, ascending. The
 * draw takes the smallest hashes per (deployment, bin) cell, so how small a
 * drawn clip's hash is depends on how crowded its cell was: a bin holding
 * 40,720 candidates contributes 23 clips whose hashes are the 23 smallest of
 * 40,720, while a bin holding 918 contributes 22 hashes spanning the full
 * range. Re-sorting the union by that same hash therefore sorts by BIN
 * ABUNDANCE — and abundance falls steeply with confidence, so the reviewer
 * walked the sample low-score-first after all.
 *
 * Measured on the 62 drawn species with >= 50 clips: mean Spearman correlation
 * between queue position and confidence +0.387 (max +0.920), and the first 20
 * clips of a queue averaged confidence 0.326 against 0.627 for the last 20.
 * Unshuffled emission order scores ~0.98, so the old permutation was closing
 * roughly half the gap it was written to close.
 *
 * The fix in `presentationOrder` is a hash INDEPENDENT of the selection hash
 * (see `mix32` there); this script applies the same permutation to samples
 * already drawn, which keep whatever order was written at draw time.
 *
 * Rewrites ONLY `order_index`. No row is added, removed or otherwise modified:
 * which clips were drawn, their confidence snapshots and every recorded review
 * are untouched, so no fit changes. Reviews key on `sample_id`, and
 * `getReviewQueue` skips already-answered clips, so a reviewer mid-species just
 * gets their remaining clips in a better order.
 *
 * Run inside the container — a bare host process against data/portal.db while
 * the container holds it open corrupts the file on macOS bind mounts:
 *
 *   docker compose exec portal node scripts/reorder-validation-samples.mjs --dry-run
 *   docker compose exec portal node scripts/reorder-validation-samples.mjs
 */

import Database from "better-sqlite3";

const dryRun = process.argv.includes("--dry-run");
const dbPath = process.env.DB_PATH || "data/portal.db";

const db = new Database(dbPath);

/**
 * 32-bit avalanche mix, byte-for-byte the `mix32` in
 * src/lib/birdnet-validation/sampling.ts. Duplicated rather than imported
 * because this is a plain .mjs run against the standalone container image,
 * which does not ship `src/`. If one changes, change both.
 */
function mix32(value) {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Spearman rank correlation between queue position and confidence. */
function positionConfidenceCorrelation(rows) {
  const n = rows.length;
  if (n < 3) return 0;
  const byConf = rows
    .map((r, i) => ({ i, c: r.confidence }))
    .sort((a, b) => a.c - b.c);
  const rank = new Array(n);
  byConf.forEach((r, k) => (rank[r.i] = k + 1));
  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = i + 1 - rank[i];
    sumD2 += d * d;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

const campaigns = db
  .prepare(`SELECT id, species, seed FROM birdnet_validation_campaigns`)
  .all();

if (campaigns.length === 0) {
  console.log("No validation rows to reorder.");
  process.exit(0);
}

const selectSamples = db.prepare(
  `SELECT id, audio_identification_id, confidence, order_index
     FROM birdnet_validation_samples
    WHERE campaign_id = ?
    ORDER BY order_index`
);
const updateOrder = db.prepare(
  `UPDATE birdnet_validation_samples SET order_index = ? WHERE id = ?`
);

let totalMoved = 0;
const before = [];
const after = [];

const run = db.transaction(() => {
  for (const campaign of campaigns) {
    const samples = selectSamples.all(campaign.id);
    if (samples.length === 0) continue;

    const salt = mix32(campaign.seed);
    const ordered = [...samples].sort((a, b) => {
      const ha = mix32(a.audio_identification_id ^ salt);
      const hb = mix32(b.audio_identification_id ^ salt);
      return ha !== hb
        ? ha - hb
        : a.audio_identification_id - b.audio_identification_id;
    });

    let moved = 0;
    ordered.forEach((sample, index) => {
      if (sample.order_index !== index) {
        if (!dryRun) updateOrder.run(index, sample.id);
        moved++;
      }
    });

    if (samples.length >= 50) {
      before.push(positionConfidenceCorrelation(samples));
      after.push(positionConfidenceCorrelation(ordered));
    }

    totalMoved += moved;
    console.log(
      `${campaign.species}: ${samples.length} muestras, ${moved} reordenadas`
    );
  }
});

run();

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
if (before.length > 0) {
  console.log(
    `\nPosition/confidence correlation across ${before.length} species with >= 50 clips:` +
      `\n  before  mean ${mean(before).toFixed(3)}  max ${Math.max(...before.map(Math.abs)).toFixed(3)}` +
      `\n  after   mean ${mean(after).toFixed(3)}  max ${Math.max(...after.map(Math.abs)).toFixed(3)}`
  );
}

console.log(
  dryRun
    ? `\nDry run — ${totalMoved} rows WOULD be reordered. Nothing written.`
    : `\nReordered ${totalMoved} rows across ${campaigns.length} species.`
);
