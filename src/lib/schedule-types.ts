/**
 * BioChoco schedule types — used by sheets-client and schedule-utils.
 */

export type ScheduleStatus = "scheduled" | "deployed" | "retrieved";

export interface ScheduleRow {
  deploymentId: string;
  siteId: string;
  siteName: string;
  habitatType: string;
  visitNumber: number;
  season: string;
  plannedDeployDate: string | null;
  plannedRetrieveDate: string | null;
  actualDeployDate: string | null;
  actualRetrieveDate: string | null;
  /** From Google Sheet — often stale. Override with getDeploymentStatus() using live ODK data. */
  status: ScheduleStatus;
  deploySlotId: number | null;
  retrieveSlotId: number | null;
  notes: string;
  driveFolderLink: string;
  // Cached upload counts from DB (only populated on /biochoco/data page)
  uploadCameraCount?: number | null;
  uploadAudioCount?: number | null;
  uploadIbuttonCount?: number | null;
  uploadCameraFolderId?: string | null;
  uploadAudioFolderId?: string | null;
  uploadIbuttonFolderId?: string | null;
  uploadCountsCheckedAt?: number | null; // unix timestamp
  uploadNewestDate?: string | null; // ISO date of most recent file across all data types
  // Field notes from DB (operational context — equipment issues, missing data)
  fieldNotes?: string | null;
}

export interface SlotRow {
  slotId: number;
  slotDate: string;
  yearMonth: string;
  dayOfMonth: number;
}

export interface ScheduleChange {
  deploymentId: string;
  field: string;
  oldValue: string;
  newValue: string;
}

export interface ScheduleRowUpdate {
  deploymentId: string;
  fields: Partial<Record<string, string | number | null>>;
}
