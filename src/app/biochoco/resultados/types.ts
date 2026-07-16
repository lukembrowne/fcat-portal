import type { SiteInfo } from "../overview/types";
import type { HabitatAssessment } from "../habitat/types";

// ---------------------------------------------------------------------------
// Data readiness
// ---------------------------------------------------------------------------

export type ReadinessStatus = "complete" | "in_progress" | "none";

export interface SiteReadiness {
  cameras: ReadinessStatus;
  temperature: ReadinessStatus;
  habitat: ReadinessStatus;
  audio: ReadinessStatus;
  /**
   * True when the site has camera/audio deployments but ALL of them are
   * excluded for that stream (excluded_camera / excluded_audio). Rendered as a
   * red ✕ overriding the readiness icon on the resultados site table. Optional
   * so other SiteReadiness consumers (map popups, public pages) are unaffected.
   */
  camerasExcluded?: boolean;
  audioExcluded?: boolean;
}

export interface SiteWithReadiness extends SiteInfo {
  readiness: SiteReadiness;
  deploymentCount: number;
}

export interface ResultadosData {
  sites: SiteWithReadiness[];
}

// ---------------------------------------------------------------------------
// Site detail
// ---------------------------------------------------------------------------

export interface SiteSpecies {
  speciesName: string;
  spanishName: string | null;
  commonName: string | null;
  taxonomicType: string | null;
  detectionCount: number;
  avgConfidence: number;
  photoImageId: number | null;
  /** IUCN Red List category code (LC/NT/VU/EN/CR/…), null when unassessed. */
  iucnStatus: string | null;
}

export interface TemperatureReading {
  timestamp: string;
  temperatureC: number;
}

export interface DeploymentTemperature {
  deploymentId: number;
  deploymentName: string;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  readings: TemperatureReading[];
  stats: {
    min: number;
    max: number;
    mean: number;
    count: number;
  } | null;
}

export interface SiteDetail {
  site: SiteInfo | null;
  deploymentCount: number;
  totalCameraTrapDays: number;
  dateRange: { start: string | null; end: string | null };
  species: SiteSpecies[];
  temperature: DeploymentTemperature[];
  temperatureStats: { min: number; max: number; mean: number } | null;
  habitat: HabitatAssessment | null;
  habitatAssessmentCount: number;
}

/** Verified BirdNET species detected at a site, used by the audio panels. */
export interface SiteAudioSpecies {
  speciesName: string;
  spanishName: string | null;
  commonName: string | null;
  detectionCount: number;
  avgConfidence: number;
}

/**
 * Audio data for a single site's drill-down. Returned separately from
 * SiteDetail so the public share view (which hides audio) can skip this
 * fetch entirely.
 */
export interface SiteAudioData {
  hasAudio: boolean;
  /** Per-diel acoustic indices boxplot groups for this site's deployments. */
  indices: import("@/app/audio/actions").AcousticIndicesGroup[];
  /** Verified BirdNET species observed at the site. */
  species: SiteAudioSpecies[];
  /** Deployments with at least one reviewed annotation. */
  reviewedDeploymentCount: number;
  /** All audio deployments at the site (denominator for the badge). */
  totalAudioDeploymentCount: number;
}
