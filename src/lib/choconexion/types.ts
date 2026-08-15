/**
 * The Choconexión bundle contract.
 *
 * This is the real interface between the portal and the public viewer — the
 * transport (a committed archive today, possibly a build-time fetch later) can
 * change without touching it. Everything here is committed to the Choconexión
 * repo and served as static files, so it must be self-contained: the viewer
 * never calls the portal.
 *
 * Deliberately absent:
 * - Elevation. The portal stores none per deployment; the viewer derives marker
 *   height from the containing plot's recorded elevation.
 * - Treatment names. `plots.json` and `treatments.json` already carry them and
 *   the viewer already renders them, so the bundle carries only `plotId`.
 * - Landowner names, in any field. Site codes only.
 * - Any audio species claim. The soundscape is atmosphere, not a detection.
 */

export const BUNDLE_SCHEMA_VERSION = 2;

/** The viewer's coordinate system, matching `plots.json`. */
export const BUNDLE_CRS = "EPSG:32617";

/**
 * Why a plot's marker looks the way it does. Decided once, in the export, so
 * the viewer never has to infer state from an empty array — an empty species
 * list with no reason is the failure this exists to prevent.
 */
export type SiteState =
  /** Surveyed, with at least one confirmed wild species. */
  | "results"
  /** Surveyed and processed, nothing confirmed. A real outcome, not a failure. */
  | "no-species"
  /** Images uploaded but not yet through the model. */
  | "unprocessed"
  /** Nothing uploaded from this site yet. */
  | "no-data";

/** One confirmed species at one site. */
export interface SiteSpecies {
  scientific: string;
  /** English common name, or the scientific name when the lookup has none. */
  english: string;
  /** Spanish common name; null falls back to English at render time (R29). */
  spanish: string | null;
  detections: number;
}

/** One exported photograph, in both sizes. */
export interface SitePhoto {
  /** `biochoco_images.id` — stable across re-exports, and the filename stem. */
  imageId: number;
  /** Repo-relative path to the strip-size WebP. */
  strip: string;
  /** Repo-relative path to the enlarged WebP. */
  full: string;
  /** The wild species confirmed in this frame, if one was. */
  species: string | null;
  /** Capture date, `YYYY-MM-DD`, Ecuador local wall-clock. */
  takenAt: string | null;
}

/** One soundscape clip. Carries no species field, by design. */
export interface SiteSoundscape {
  /** Repo-relative path to the AAC clip. */
  file: string;
  /** Recording date, `YYYY-MM-DD`. */
  recordedAt: string | null;
  /** Local time of the recording, `HH:MM`, behind the period label. */
  recordedTime: string | null;
  /**
   * The diel period the clip was selected from — `dawn`, `midday`, `dusk` or
   * `night`. The viewer labels the clip from this, so it is the key a reader
   * chooses by, not a provenance note.
   */
  dielPeriod: string;
  /** Clip length in seconds. */
  durationSeconds: number;
}

/** The deployment window, in Ecuador local wall-clock dates. */
export interface SiteWindow {
  /** `YYYY-MM-DD`. */
  start: string;
  /** `YYYY-MM-DD`, or null while the deployment is still open. */
  end: string | null;
  /** Whole days between start and end; null when the window has no end. */
  days: number | null;
  /** True when the window came from the QA-validated dates rather than ODK's. */
  validated: boolean;
}

export interface SiteRecord {
  /** Choconexión plot, `P01`..`P16`. */
  plotId: string;
  /** BioChoco site code. Never a landowner name. */
  siteCode: string;
  state: SiteState;
  /** Easting in `BUNDLE_CRS`; null when the site has no recorded position. */
  x: number | null;
  /** Northing in `BUNDLE_CRS`; null when the site has no recorded position. */
  y: number | null;
  window: SiteWindow | null;
  species: SiteSpecies[];
  photos: SitePhoto[];
  /**
   * One clip per diel period that has usable audio, in day order. Empty for a
   * site with no processed audio at all. A period is absent rather than present
   * with a null file, so the viewer's chips are a list, not a lookup with holes.
   */
  soundscapes: SiteSoundscape[];
  /**
   * Images uploaded but not yet processed. Only meaningful in the `unprocessed`
   * state, where the panel says "N images awaiting processing".
   */
  pendingImages: number | null;
}

/** One species across the whole experiment, for the species lens. */
export interface RosterSpecies {
  scientific: string;
  english: string;
  spanish: string | null;
  /** How many plots it was confirmed in. */
  plots: number;
  /** Total detections across the experiment. */
  detections: number;
}

export interface ChoconexionBundle {
  schemaVersion: number;
  /** ISO 8601 date the bundle was produced. Surfaced in the viewer. */
  generatedAt: string;
  crs: string;
  sites: SiteRecord[];
  /** Every species confirmed anywhere in the experiment, richest first. */
  species: RosterSpecies[];
}
