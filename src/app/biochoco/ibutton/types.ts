/**
 * Shared types for the iButton temperature dashboard.
 */

export interface IbuttonStatus {
  total: number; // deployments with iButton files in Drive
  processed: number; // deployments with parsed data in DB
  unprocessed: number; // deployments pending processing
  totalReadings: number;
}

export interface ProcessingResult {
  processed: number;
  failed: number;
  errors: string[];
}

export interface HabitatSummary {
  habitatType: string;
  habitatLabel: string;
  deploymentCount: number;
  readingCount: number;
  tempMin: number;
  tempMax: number;
  tempMean: number;
}

export interface DeploymentSummary {
  deploymentId: number;
  deploymentName: string;
  siteName: string | null;
  habitatType: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  readingCount: number;
  tempMin: number;
  tempMax: number;
  tempMean: number;
  flaggedCount: number;
  processedAt: Date | null;
  processedBy: string | null;
}

export interface DeploymentDetail {
  deployment: {
    id: number;
    name: string;
    siteName: string | null;
    habitatType: string | null;
    dateStart: string | null;
    dateEnd: string | null;
  };
  upload: {
    id: number;
    filename: string;
    deviceSerial: string | null;
    sampleRate: string | null;
    missionStart: string | null;
    rowsImported: number;
    dateRangeStart: string | null;
    dateRangeEnd: string | null;
    processedBy: string;
    processedAt: Date;
  } | null;
  readings: {
    id: number;
    timestamp: string;
    temperatureC: number;
    flagged: boolean;
  }[];
  stats: {
    count: number;
    min: number;
    max: number;
    mean: number;
    stdDev: number;
    flaggedCount: number;
  } | null;
}
