/**
 * Score-bin-stratified draw of BirdNET detections for expert validation.
 *
 * Two properties matter and both are load-bearing:
 *
 *  1. UNIFORM ACROSS SCORE BINS (see binning.ts) so the logistic fit has
 *     resolution in the transition zone rather than mirroring the U-shaped
 *     score distribution.
 *
 *  2. SPREAD ACROSS DEPLOYMENTS within each bin. A bin drawn entirely from one
 *     site measures that site's confounding frog, not the species. The draw
 *     takes one candidate from every deployment before any deployment's second
 *     (Symes, pers. comm. 2026: "watch for the perfect confounding frog").
 *
 * The draw is reproducible: candidate ordering is a pure function of the
 * campaign's stored seed and the identification id, so re-running a draw with
 * the same seed selects the same detections.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { allocateBins } from "./binning";
import { binEdges, SCORE_CEILING, SCORE_FLOOR } from "./types";

/**
 * Knuth multiplicative hash constant. SQLite has no seedable RNG and no built-in
 * hash, so candidate ordering comes from integer arithmetic over (seed, id).
 * Max identification id (~2.5M) x this constant stays far inside SQLite's signed
 * 64-bit integer range, so there is no overflow to guard against.
 *
 * `(id + seed) * M mod P` is affine, so the seed rotates one fixed cyclic order
 * rather than reshuffling it. That is FINE HERE and only here: the draw takes
 * the first k candidates per bin, so a rotation lands on a different arc of the
 * cycle and genuinely selects a different subset. It is not fine for ordering a
 * set already chosen — see `mix32`, which exists because of that difference.
 */
const HASH_MULTIPLIER = 2654435761;
const HASH_MODULUS = 2147483647;

export interface SampleCandidate {
  audioIdentificationId: number;
  confidence: number;
  binIndex: number;
  deploymentId: number | null;
  siteName: string | null;
}

export interface DrawOptions {
  species: string;
  /** Accessible camera-trap project ids, or "all" for super admins. */
  ctProjects: number[] | "all";
  binCount: number;
  target: number;
  seed: number;
  /** Identification ids already sampled — never drawn twice. */
  excludeIds?: number[];
}

/**
 * 32-bit avalanche mix ("lowbias32"), used for presentation order only.
 *
 * WHY NOT THE KNUTH HASH ABOVE: `(id + seed) * M mod P` is affine in `id`, so
 * adding the seed shifts every hash by the same constant `seed * M mod P`.
 * Sorting by it therefore yields ONE fixed cyclic order, rotated to a different
 * starting point per seed — not a different permutation. Measured on a real
 * 200-clip sample: 5000 distinct seeds produced 14 distinct orderings, and the
 * position/confidence correlation sat at -0.152 for every one of them (sd
 * 0.008, where an actual reshuffle gives sd 1/sqrt(n-1) = 0.071). Any single
 * chain of multiplies and adds has this property; breaking it needs the
 * nonlinear xor-shift steps below.
 *
 * Every operation is int32, so nothing leaves the range JS bitwise operators
 * work in — which is why this is written with `Math.imul` rather than `*`.
 */
function mix32(value: number): number {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Permute candidates so queue position carries no score information.
 *
 * The draw emits in score order — bin by bin ascending — and `order_index` is
 * assigned from that emission order. Presenting the sample that way walks the
 * reviewer from the worst clips to the best, which anchors their judgment
 * against the very predictor the logistic fit is measuring. The review UI hides
 * the score for exactly this reason; leaving the ORDER correlated with it leaks
 * the same information more slowly.
 *
 * Which clips were drawn is unchanged — only the order they are shown in, and
 * the order stays reproducible from the campaign's stored seed rather than
 * being a genuinely random shuffle. The seed is mixed rather than added; see
 * `mix32` for what adding it actually produced.
 */
export function presentationOrder<T extends { audioIdentificationId: number }>(
  candidates: T[],
  seed: number
): T[] {
  // Mixed once, not per comparison — the sort calls this O(n log n) times.
  const salt = mix32(seed);
  return [...candidates].sort((a, b) => {
    const ha = mix32(a.audioIdentificationId ^ salt);
    const hb = mix32(b.audioIdentificationId ^ salt);
    if (ha !== hb) return ha - hb;
    // Deterministic tiebreaker; hash collisions are possible in principle.
    return a.audioIdentificationId - b.audioIdentificationId;
  });
}

/**
 * Project scoping predicate. Kept as a raw fragment because the surrounding
 * queries are raw SQL (window functions) rather than the Drizzle query builder.
 */
function projectScope(ctProjects: number[] | "all") {
  if (ctProjects === "all") return sql`1 = 1`;
  if (ctProjects.length === 0) return sql`1 = 0`;
  return sql`d.ct_project_id IN (${sql.join(
    ctProjects.map((id) => sql`${id}`),
    sql`, `
  )})`;
}

function excludeScope(excludeIds: number[] | undefined) {
  if (!excludeIds || excludeIds.length === 0) return sql`1 = 1`;
  return sql`ai.id NOT IN (${sql.join(
    excludeIds.map((id) => sql`${id}`),
    sql`, `
  )})`;
}

/**
 * Bin index expression. Mirrors `binIndexFor` in types.ts — MIN() clamps
 * confidence of exactly 1.0 into the last bin rather than letting it fall into
 * a phantom bin past the end, which would silently drop every top-scoring
 * detection from the sample.
 */
function binExpr(binCount: number) {
  const width = (SCORE_CEILING - SCORE_FLOOR) / binCount;
  return sql`MIN(${binCount - 1}, CAST((ai.confidence - ${SCORE_FLOOR}) / ${width} AS INTEGER))`;
}

/**
 * How many detections of this species exist in each confidence bin.
 *
 * Filters on `ai.species` — BirdNET's raw prediction — not the effective
 * species. Validation measures how often BirdNET's prediction of X is right, so
 * a row a human later corrected to something else is still a prediction of X
 * and belongs in the denominator.
 */
export async function countByBin(
  species: string,
  ctProjects: number[] | "all",
  binCount: number
): Promise<number[]> {
  const rows = db.all<{ bin_index: number; n: number }>(sql`
    SELECT ${binExpr(binCount)} AS bin_index, COUNT(*) AS n
    FROM audio_identifications ai
    JOIN audio_detections ad ON ad.id = ai.audio_detection_id
    JOIN audio_files af ON af.id = ad.audio_file_id
    JOIN biochoco_deployments d ON d.id = af.deployment_id
    WHERE ai.species = ${species}
      AND ai.confidence IS NOT NULL
      AND ai.confidence >= ${SCORE_FLOOR}
      AND ai.confidence <= ${SCORE_CEILING}
      AND ${projectScope(ctProjects)}
    GROUP BY bin_index
  `);

  const counts = new Array<number>(binCount).fill(0);
  for (const row of rows) {
    if (row.bin_index >= 0 && row.bin_index < binCount) {
      counts[row.bin_index] = Number(row.n);
    }
  }
  return counts;
}

/**
 * Draw candidates from one bin, interleaved across deployments.
 *
 * ROW_NUMBER() partitioned by deployment ranks each site's candidates
 * independently; ordering the outer query by that rank takes every site's
 * first pick before any site's second. The hash breaks ties deterministically
 * and also randomises which candidate within a site comes first.
 */
async function drawFromBin(
  opts: DrawOptions,
  binIndex: number,
  lo: number,
  hi: number,
  isLastBin: boolean,
  limit: number
): Promise<SampleCandidate[]> {
  if (limit <= 0) return [];

  // Only the final bin includes its upper edge, so confidence exactly 1.0 is
  // drawable rather than falling between bins.
  const upperBound = isLastBin
    ? sql`ai.confidence <= ${hi}`
    : sql`ai.confidence < ${hi}`;

  const rows = db.all<{
    id: number;
    confidence: number;
    deployment_id: number | null;
    site_name: string | null;
  }>(sql`
    SELECT id, confidence, deployment_id, site_name FROM (
      SELECT ai.id                AS id,
             ai.confidence        AS confidence,
             af.deployment_id     AS deployment_id,
             d.site_name          AS site_name,
             ROW_NUMBER() OVER (
               PARTITION BY af.deployment_id
               ORDER BY ((ai.id + ${opts.seed}) * ${HASH_MULTIPLIER}) % ${HASH_MODULUS}
             ) AS rn,
             ((ai.id + ${opts.seed}) * ${HASH_MULTIPLIER}) % ${HASH_MODULUS} AS h
      FROM audio_identifications ai
      JOIN audio_detections ad ON ad.id = ai.audio_detection_id
      JOIN audio_files af ON af.id = ad.audio_file_id
      JOIN biochoco_deployments d ON d.id = af.deployment_id
      WHERE ai.species = ${opts.species}
        AND ai.confidence IS NOT NULL
        AND ai.confidence >= ${lo}
        AND ${upperBound}
        AND ${projectScope(opts.ctProjects)}
        AND ${excludeScope(opts.excludeIds)}
    )
    ORDER BY rn, h
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    audioIdentificationId: Number(row.id),
    confidence: Number(row.confidence),
    binIndex,
    deploymentId: row.deployment_id == null ? null : Number(row.deployment_id),
    siteName: row.site_name,
  }));
}

export interface StratifiedDraw {
  candidates: SampleCandidate[];
  /** Per-bin availability, for reporting the realised design. */
  available: number[];
  /** Per-bin target from allocateBins. */
  allocated: number[];
}

/** Draw the full stratified sample for a campaign. */
export async function drawStratifiedSample(
  opts: DrawOptions
): Promise<StratifiedDraw> {
  const available = await countByBin(opts.species, opts.ctProjects, opts.binCount);
  const allocated = allocateBins(available, opts.target);
  const edges = binEdges(opts.binCount);

  const candidates: SampleCandidate[] = [];
  for (let i = 0; i < opts.binCount; i++) {
    const drawn = await drawFromBin(
      opts,
      i,
      edges[i].lo,
      edges[i].hi,
      i === opts.binCount - 1,
      allocated[i]
    );
    candidates.push(...drawn);
  }

  return { candidates, available, allocated };
}
