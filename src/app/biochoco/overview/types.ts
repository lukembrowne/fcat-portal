import type { ScheduleRow } from "@/lib/schedule-types";

export interface SiteInfo {
  siteId: string;
  siteName: string;
  habitatType: string;
  lat: number | null;
  lng: number | null;
  habitatAssessed: string;
}

export interface BiochocoOverviewData {
  schedule: ScheduleRow[];
  sites: SiteInfo[];
  deployedIds: string[];
  retrievedIds: string[];
}

export const HABITAT_NAMES: Record<string, string> = {
  primary_forest: "Bosque Primario",
  secondary_forest: "Bosque Secundario",
  cacao_nacional: "Cacao Nacional",
  cacao_giz: "Cacao GIZ",
  cacao_ccn: "Cacao CCN",
  reforestation: "Reforestación",
  pasture: "Potrero",
};

export const SPANISH_MONTHS: Record<number, string> = {
  0: "Enero", 1: "Febrero", 2: "Marzo", 3: "Abril",
  4: "Mayo", 5: "Junio", 6: "Julio", 7: "Agosto",
  8: "Septiembre", 9: "Octubre", 10: "Noviembre", 11: "Diciembre",
};

export function getHabitatName(h: string): string {
  return HABITAT_NAMES[h] ?? h.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getDeploymentStatus(
  deploymentId: string,
  deployedSet: Set<string>,
  retrievedSet: Set<string>
): "scheduled" | "deployed" | "retrieved" {
  if (retrievedSet.has(deploymentId)) return "retrieved";
  if (deployedSet.has(deploymentId)) return "deployed";
  return "scheduled";
}
