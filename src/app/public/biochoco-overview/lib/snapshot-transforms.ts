/**
 * Pure transforms for the public overview snapshot.
 *
 * Everything here is DB-free and side-effect-free so it can be unit tested
 * directly. The SQL that feeds these lives in build-snapshot.ts.
 */

import type { CameraSpeciesRow, CuratedAudioClip, CuratedImage } from "./snapshot-types";

/** Species metadata as stored in biochoco_species (the subset we use). */
export interface SpeciesMeta {
  type: string;
  taxonomicRank: string | null;
  commonName: string;
  spanishName: string | null;
}

/** A raw "effective label" tally coming out of the identifications query. */
export interface EffectiveSpeciesRow {
  eff: string;
  detections: number;
}

/**
 * Site code = the leading token of a deployment name before the first "_".
 * Deployment names embed landowner names ("CCN-001 - Don Adrian"); the code
 * ("CCN-001") is the only outward-safe identifier.
 */
export function siteCode(name: string): string {
  const withSentinel = `${name}_`;
  return withSentinel.slice(0, withSentinel.indexOf("_"));
}

/**
 * Coarsen a coordinate for public display. Rounding to 2 decimals (~1.1 km)
 * hides exact camera locations while keeping the reserve-scale map faithful.
 */
export function coarsenCoord(value: number | null): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * A row counts as a real species only if it maps to a non-system entry at
 * species rank. This drops "Unknown"/"Homo sapiens" (system) and higher-taxa
 * labels like "Aves" (class), "Rodentia" (order), "Leptotila sp." (genus).
 */
export function isRealSpecies(meta: SpeciesMeta | undefined): meta is SpeciesMeta {
  return (
    !!meta &&
    meta.type !== "system" &&
    (!meta.taxonomicRank || meta.taxonomicRank === "species")
  );
}

/**
 * From effective-label tallies + species metadata, produce the real-species
 * headline: total count, per-type breakdown, and the top-N list.
 */
export function summarizeCameraSpecies(
  effRows: EffectiveSpeciesRow[],
  speciesMeta: Map<string, SpeciesMeta>,
  topN = 20,
): {
  cameraRealSpecies: number;
  cameraSpeciesByType: Record<string, number>;
  cameraTopSpecies: CameraSpeciesRow[];
} {
  const realRows = effRows.filter((r) => isRealSpecies(speciesMeta.get(r.eff)));

  const cameraSpeciesByType: Record<string, number> = {};
  for (const r of realRows) {
    const t = speciesMeta.get(r.eff)!.type;
    cameraSpeciesByType[t] = (cameraSpeciesByType[t] || 0) + 1;
  }

  const cameraTopSpecies: CameraSpeciesRow[] = realRows.slice(0, topN).map((r) => {
    const m = speciesMeta.get(r.eff)!;
    return {
      sci: r.eff,
      spanishName: m.spanishName,
      commonName: m.commonName,
      type: m.type,
      detections: r.detections,
    };
  });

  return {
    cameraRealSpecies: realRows.length,
    cameraSpeciesByType,
    cameraTopSpecies,
  };
}

/**
 * Resolve a curation manifest against the ids that actually exist and belong to
 * the project. Entries whose id is unknown/foreign are dropped (not fatal), so a
 * stale manifest never fails a publish or leaks a foreign asset onto the page.
 */
export function resolveCuratedImages(
  manifest: CuratedImage[],
  validImageIds: ReadonlySet<number>,
): { images: CuratedImage[]; droppedImageIds: number[] } {
  const images: CuratedImage[] = [];
  const droppedImageIds: number[] = [];
  for (const entry of manifest) {
    if (validImageIds.has(entry.imageId)) images.push(entry);
    else droppedImageIds.push(entry.imageId);
  }
  return { images, droppedImageIds };
}

export function resolveCuratedAudio(
  manifest: CuratedAudioClip[],
  validAudioIds: ReadonlySet<number>,
): { audio: CuratedAudioClip[]; droppedAudioIds: number[] } {
  const audio: CuratedAudioClip[] = [];
  const droppedAudioIds: number[] = [];
  for (const entry of manifest) {
    if (validAudioIds.has(entry.audioId)) audio.push(entry);
    else droppedAudioIds.push(entry.audioId);
  }
  return { audio, droppedAudioIds };
}
