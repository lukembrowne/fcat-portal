/**
 * Photograph selection and WebP export for the Choconexión bundle.
 *
 * All 866 images at these sites have a null `path` and a null `thumbnail_path`,
 * so nothing is on local disk: each chosen frame is fetched from Drive and
 * encoded here. That makes selection expensive enough to be worth doing well —
 * eight frames per site, not eighty.
 *
 * Ranking, in order:
 *
 * 1. **Starred frames.** A human already said these are the good ones. There
 *    are only 30 across the whole experiment, so this leads the strip but
 *    cannot fill it — the ranking has to degrade gracefully, which is the whole
 *    reason for the rest of the order.
 * 2. **Frames carrying a confirmed wild species**, drawn round-robin across
 *    species so one abundant animal cannot take the whole strip. The real data
 *    makes this concrete: REF-007's first six frames are all armadillo, seconds
 *    apart, because camera traps fire in bursts.
 * 3. Within one species, frames are spread evenly across the deployment rather
 *    than taken consecutively, for the same burst reason.
 *
 * Photo counts are never survey effort — these are the frames that survived
 * verification, not what the camera captured. Nothing here emits a count.
 */

import "server-only";

import path from "node:path";
import { promises as fs } from "node:fs";

import sharp from "sharp";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { log } from "@/lib/log";
import { isWildSpecies } from "@/lib/species-filters";

import type { SitePhoto } from "./types";
import type { SpeciesMetaRow } from "./build-sites";

/** Maximum frames per site. Sites with fewer qualifying frames ship fewer. */
export const MAX_PHOTOS_PER_SITE = 8;

/**
 * Encoder settings copied from the Choconexión repo's own `generate-thumbs.mjs`
 * so the bundle matches the convention already in that repo. These are
 * dense-foliage photographs that compress badly, which is why effort is high.
 */
const STRIP_WIDTH = 480;
const FULL_WIDTH = 1400;
const WEBP_QUALITY = 72;
const WEBP_EFFORT = 6;

/** Ecuador is UTC-5 year-round, with no daylight saving. */
const ECUADOR_OFFSET_MS = 5 * 60 * 60 * 1000;

export interface PhotoCandidate {
  imageId: number;
  driveFileId: string | null;
  starred: boolean;
  /** Effective wild species confirmed in this frame, or null. */
  species: string | null;
  /** Unix seconds — `exif_timestamp` when present, else `file_modified`. */
  takenAtEpoch: number | null;
}

/**
 * Capture date as an Ecuador local calendar date.
 *
 * The stored value is an instant. Formatting it with UTC getters puts an
 * evening photograph on the following day, which is how a nocturnal animal ends
 * up dated wrong on a public page.
 */
export function takenAtDate(epochSeconds: number | null): string | null {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return null;
  const local = new Date(epochSeconds * 1000 - ECUADOR_OFFSET_MS);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString().slice(0, 10);
}

/**
 * Pick `count` items spread evenly across `items`, always including the first.
 * Used to avoid returning a burst of near-identical frames.
 */
export function spreadEvenly<T>(items: T[], count: number): T[] {
  if (count >= items.length) return [...items];
  if (count <= 0) return [];
  const step = items.length / count;
  const picked: T[] = [];
  for (let i = 0; i < count; i++) picked.push(items[Math.floor(i * step)]);
  return picked;
}

/**
 * Rank a site's candidates and take at most `limit`.
 *
 * Deterministic: image id breaks every tie, so re-exporting unchanged data
 * produces an identical selection and therefore no diff.
 *
 * `limit` is a floor as well as a cap. The viewer shows a thumbnail beside each
 * species name, so a species with no frame in the selection renders as a name
 * with a blank where its example should be — which reads as missing data rather
 * than as the cap doing its job. Every species present in the pool therefore
 * gets a frame, even where that means exceeding `limit` (P16: eleven species,
 * eight slots).
 *
 * The budget is worked out AFTER the starred pass, and species still missing an
 * example are served BEFORE species that already have one. Neither is optional:
 * starred frames consume slots, so sizing the budget up front leaves too few;
 * and the round-robin walks every group in abundance order, so without the
 * reordering it spends those slots on a second agouti while the site's only
 * tamandua goes unrepresented. That is exactly what happened on the first
 * attempt at P16 — three starred frames in, ten of eleven species covered.
 */
export function rankPhotoCandidates(
  candidates: PhotoCandidate[],
  limit = MAX_PHOTOS_PER_SITE,
): PhotoCandidate[] {
  const usable = candidates.filter((c) => c.driveFileId);
  const byId = (a: PhotoCandidate, b: PhotoCandidate) => a.imageId - b.imageId;

  // Dedupe by image id as the selection is built, not afterwards: the same
  // frame must never occupy two slots in an eight-slot strip.
  const chosen: PhotoCandidate[] = [];
  const taken = new Set<number>();
  for (const c of usable.filter((c) => c.starred).sort(byId)) {
    if (chosen.length >= limit) break;
    if (taken.has(c.imageId)) continue;
    chosen.push(c);
    taken.add(c.imageId);
  }

  // Group the identified frames by species.
  const groups = new Map<string, PhotoCandidate[]>();
  for (const c of usable) {
    if (taken.has(c.imageId) || !c.species) continue;
    const group = groups.get(c.species);
    if (group) group.push(c);
    else groups.set(c.species, [c]);
  }

  // A starred frame counts as its species' example, so it is not owed another.
  const covered = new Set(
    chosen.map((c) => c.species).filter((s): s is string => Boolean(s)),
  );
  const owed = [...groups.keys()].filter((s) => !covered.has(s)).length;
  const effectiveLimit = Math.max(limit, chosen.length + owed);

  let remaining = effectiveLimit - chosen.length;
  if (remaining <= 0) return chosen;

  // Species without an example first, then commonest, then name — a stable
  // order that does not depend on Map insertion or on the query's row order.
  const ordered = [...groups.entries()]
    .sort((a, b) =>
      Number(covered.has(a[0])) - Number(covered.has(b[0])) ||
      b[1].length - a[1].length ||
      a[0].localeCompare(b[0]))
    .map(([species, list]) => {
      list.sort(byId);
      // Pre-spread each group so the round-robin draws from across the
      // deployment rather than off the front of a burst.
      return { species, list: spreadEvenly(list, Math.min(list.length, effectiveLimit)) };
    });

  // Round-robin: every species gives up its first frame before any gives a second.
  let round = 0;
  while (remaining > 0) {
    let placedThisRound = false;
    for (const group of ordered) {
      if (remaining <= 0) break;
      const candidate = group.list[round];
      if (!candidate || taken.has(candidate.imageId)) continue;
      chosen.push(candidate);
      taken.add(candidate.imageId);
      remaining--;
      placedThisRound = true;
    }
    if (!placedThisRound) break;
    round++;
  }

  return chosen;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Injected so the encoder is testable without Drive credentials. */
export type ImageFetcher = (driveFileId: string) => Promise<Buffer>;

export interface ExportPhotosOptions {
  siteCode: string;
  candidates: PhotoCandidate[];
  /** Absolute directory for this site's photos. */
  outDir: string;
  /** Path prefix recorded in the bundle, e.g. `sites/REF-007/photos`. */
  publicPrefix: string;
  fetchImage: ImageFetcher;
  limit?: number;
}

export interface ExportPhotosResult {
  photos: SitePhoto[];
  warnings: string[];
}

/**
 * Fetch, encode and write the chosen frames.
 *
 * One frame failing drops that frame and continues: a single unreadable file on
 * Drive must not cost the site, let alone the run.
 */
export async function exportSitePhotos({
  siteCode,
  candidates,
  outDir,
  publicPrefix,
  fetchImage,
  limit = MAX_PHOTOS_PER_SITE,
}: ExportPhotosOptions): Promise<ExportPhotosResult> {
  const chosen = rankPhotoCandidates(candidates, limit);
  if (chosen.length === 0) return { photos: [], warnings: [] };

  await fs.mkdir(outDir, { recursive: true });

  const photos: SitePhoto[] = [];
  const warnings: string[] = [];

  for (const candidate of chosen) {
    try {
      const source = await fetchImage(candidate.driveFileId!);
      const stripName = `${candidate.imageId}-strip.webp`;
      const fullName = `${candidate.imageId}-full.webp`;

      await encodeWebp(source, path.join(outDir, stripName), STRIP_WIDTH);
      await encodeWebp(source, path.join(outDir, fullName), FULL_WIDTH);

      photos.push({
        imageId: candidate.imageId,
        strip: `${publicPrefix}/${stripName}`,
        full: `${publicPrefix}/${fullName}`,
        species: candidate.species,
        takenAt: takenAtDate(candidate.takenAtEpoch),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(
        `${siteCode}: no se pudo exportar la imagen ${candidate.imageId} (${message}).`,
      );
      log.warn(
        { siteCode, imageId: candidate.imageId, err: message },
        "[choconexion] photo export failed, skipping",
      );
    }
  }

  return { photos, warnings };
}

async function encodeWebp(source: Buffer, outPath: string, width: number): Promise<void> {
  await sharp(source)
    .rotate() // honour the EXIF orientation before resizing
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
    .toFile(outPath);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

interface RawCandidateRow {
  deploymentId: number;
  imageId: number;
  driveFileId: string | null;
  starred: number;
  species: string | null;
  exifTimestamp: string | null;
  fileModified: number | null;
}

/**
 * Candidate frames for the given deployments, keyed by deployment id.
 *
 * A frame's species is its first confirmed identification. Frames whose only
 * identification is a bucket class or a domestic animal keep a null species and
 * so rank below identified frames without being excluded outright — a starred
 * frame stays eligible on the strength of the star.
 */
export async function loadPhotoCandidates(
  deploymentIds: number[],
  speciesMeta: Map<string, SpeciesMetaRow>,
): Promise<Map<number, PhotoCandidate[]>> {
  const byDeployment = new Map<number, PhotoCandidate[]>();
  if (deploymentIds.length === 0) return byDeployment;

  const rows = await db.all<RawCandidateRow>(sql`
    SELECT
      img.deployment_id   AS deploymentId,
      img.id              AS imageId,
      img.drive_file_id   AS driveFileId,
      img.starred         AS starred,
      img.exif_timestamp  AS exifTimestamp,
      img.file_modified   AS fileModified,
      (SELECT COALESCE(i.corrected_species, i.species)
         FROM biochoco_detections det
         JOIN biochoco_identifications i ON i.detection_id = det.id
        WHERE det.image_id = img.id
          AND i.verification_status IN ('verified', 'corrected')
        ORDER BY i.id
        LIMIT 1)          AS species
    FROM biochoco_images img
    WHERE img.deployment_id IN (${sql.join(
      deploymentIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND img.drive_file_id IS NOT NULL
      AND (img.confirmed_blank IS NULL OR img.confirmed_blank = 0)
    ORDER BY img.deployment_id, img.id`);

  for (const row of rows) {
    const wild =
      row.species && isWildSpecies(speciesMeta.get(row.species), row.species)
        ? row.species
        : null;

    const candidate: PhotoCandidate = {
      imageId: row.imageId,
      driveFileId: row.driveFileId,
      starred: Boolean(row.starred),
      species: wild,
      takenAtEpoch: resolveTakenAt(row.exifTimestamp, row.fileModified),
    };

    const list = byDeployment.get(row.deploymentId);
    if (list) list.push(candidate);
    else byDeployment.set(row.deploymentId, [candidate]);
  }

  return byDeployment;
}

/**
 * EXIF first, Drive mtime second.
 *
 * The dateless-filename cameras at these sites carry no EXIF at all, so
 * `file_modified` — the SD-card mtime, which is the camera clock — is the only
 * timestamp most of these frames have.
 */
export function resolveTakenAt(
  exifTimestamp: string | null,
  fileModified: number | null,
): number | null {
  if (exifTimestamp) {
    // Stored as Ecuador local wall-clock, same convention as the recorders.
    const parsed = Date.parse(`${exifTimestamp.replace(" ", "T")}Z`);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000) + ECUADOR_OFFSET_MS / 1000;
  }
  return fileModified ?? null;
}
