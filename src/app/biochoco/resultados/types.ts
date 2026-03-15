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
