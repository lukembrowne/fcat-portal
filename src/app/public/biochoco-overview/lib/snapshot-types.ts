/**
 * Types for the public BioChoco overview snapshot.
 *
 * A snapshot is the single source of truth the public page and its media
 * routes read from. It is produced at publish time (see build-snapshot.ts),
 * stored as one row per slug (see src/lib/public-report-snapshot.ts), and
 * contains only outward-safe, DB-derived data plus the resolved curated media.
 *
 * No server-only imports here — this file is shared with client components.
 */

export type Lang = "en" | "es";

export interface Bilingual {
  en: string;
  es: string;
}

/** A camera "real species" row (higher taxa + system labels already filtered out). */
export interface CameraSpeciesRow {
  sci: string;
  spanishName: string | null;
  commonName: string;
  type: string; // mammal | bird | reptile | amphibian | insect
  detections: number;
}

/** A public map point. Site code only (never landowner names); coordinates coarsened. */
export interface DeploymentPoint {
  code: string;
  status: string;
  habitat: string;
  lat: number | null;
  lng: number | null;
  dateStart: string | null;
  dateEnd: string | null;
  detections: number;
}

export interface ReportStats {
  project: { id: number; name: string } | null;
  deploymentCount: number;
  retrievedCount: number;
  retrievedSensors: { cam: number; audio: number; climate: number };
  distinctSites: number;
  /** Distinct sites per habitat key (from the ODK-derived site→habitat map). */
  habitatCounts: Record<string, number>;
  byStatus: { status: string; n: number }[];
  samplingSpan: { start: string | null; end: string | null };
  cameraTrapDays: number;
  totalImages: number;
  totalDetections: number;
  cameraRealSpecies: number;
  cameraSpeciesByType: Record<string, number>;
  /** Count of verified + corrected camera identifications (human-reviewed). */
  identificationsReviewed: number;
  cameraTopSpecies: CameraSpeciesRow[];
  audio: { files: number; bytes: number; deployments: number };
  audioSpeciesCount: number;
  audioDetections08: number;
  audioReviewedSpeciesCount: number;
  audioThreshold: number;
  audioTopSpecies: { sci: string; detections: number }[];
  ibutton: { processed: number; readings: number };
  uploadBytes: { camera: number; audio: number; ibutton: number };
  uploadCounts: { camPhotos: number; audioFiles: number; ibuttonFiles: number };
  deploymentsByMonth: { month: string; n: number }[];
  deployments: DeploymentPoint[];
}

/** A curated photo baked into the snapshot; imageId is served by the public image route. */
export interface CuratedImage {
  imageId: number;
  speciesLabel: string;
  caption: Bilingual;
}

/** A curated audio clip; audioId is served by the public audio route. */
export interface CuratedAudioClip {
  audioId: number;
  speciesLabel: string;
  caption: Bilingual;
  /**
   * Pre-rendered spectrogram as a `data:<mime>;base64,…` URI, generated at
   * publish time.
   *
   * SERVER-SIDE ONLY. `stripSpectrograms` removes this before the snapshot is
   * handed to the client component — inlining it would serialize ~70 KB of
   * base64 per clip twice (SSR HTML + RSC flight payload). The page loads the
   * image from `/api/public/report-spectrogram/[id]`, which reads this field.
   */
  spectrogramPng?: string;
  /**
   * Client-safe replacement for `spectrogramPng`: true when a pre-rendered
   * spectrogram exists. When false the page falls back to computing the
   * spectrogram in the browser.
   */
  hasSpectrogram?: boolean;
}

export interface ReportSnapshot {
  slug: string;
  /** ISO 8601 timestamp of when this snapshot was published. */
  generatedAt: string;
  generatedBy: string | null;
  stats: ReportStats;
  images: CuratedImage[];
  audio: CuratedAudioClip[];
}
