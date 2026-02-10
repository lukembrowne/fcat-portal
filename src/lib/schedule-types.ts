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
  status: ScheduleStatus;
  deploySlotId: number | null;
  retrieveSlotId: number | null;
  notes: string;
  driveFolderLink: string;
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
