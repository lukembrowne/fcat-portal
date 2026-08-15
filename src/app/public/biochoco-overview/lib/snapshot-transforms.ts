/**
 * Pure transforms for the public overview snapshot.
 *
 * Everything here is DB-free and side-effect-free so it can be unit tested
 * directly. The SQL that feeds these lives in build-snapshot.ts.
 */

import { isRealSpecies } from "@/lib/species-filters";

import type {
  CameraSpeciesRow,
  CuratedAudioClip,
  CuratedImage,
  ReportSnapshot,
} from "./snapshot-types";

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
 * Pass a coordinate through for public display, guarding null/NaN only.
 * Sampling-site coordinates are shown at full precision (FCAT's call — the
 * exact deployment locations are intentionally public on the map).
 */
export function exactCoord(value: number | null): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return value;
}

/**
 * Re-exported so existing importers keep working. The rule itself lives in
 * `@/lib/species-filters`, shared with the public download route and the
 * Choconexión bundle export.
 */
export { isRealSpecies };

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

/**
 * Drop the pre-rendered spectrogram data URIs, replacing each with a boolean.
 *
 * Must run on every snapshot before it crosses into a client component. React
 * serializes client-component props TWICE — once into the SSR HTML, once into
 * the RSC flight payload appended to it — so an inlined spectrogram costs its
 * base64 size twice per page load and can never be cached separately. Six clips
 * of full-resolution PNG made the public page a 21 MB document; the page now
 * points `<img>` at /api/public/report-spectrogram/[id] instead.
 */
export function stripSpectrograms(snapshot: ReportSnapshot): ReportSnapshot {
  return {
    ...snapshot,
    audio: snapshot.audio.map(({ spectrogramPng, ...clip }) => ({
      ...clip,
      hasSpectrogram: Boolean(spectrogramPng),
    })),
  };
}
