import type { SiteInfo } from "../overview/types";

export interface HabitatAssessment {
  instanceId: string;
  siteId: string;
  siteName: string;
  habitatType: string;
  assessmentDate: string;
  canopyCoverPercent: number;
  canopyHeightClass: string;
  treesMedium: number;
  treesLarge: number;
  understoryDensity: string;
  slopeCategory: string;
  distanceToEdgeM: number;
  adjacentHabitat: string;
  disturbanceSigns: string;
  habitatNotes: string;
  photoNorth: string;
  photoEast: string;
  photoSouth: string;
  photoWest: string;
  photoCanopy: string;
}

export interface HabitatData {
  sites: SiteInfo[];
  assessments: HabitatAssessment[];
  assessedSiteIds: Set<string>;
}

export const HABITAT_COLORS: Record<string, string> = {
  primary_forest: "#1b7a3d",
  secondary_forest: "#4caf50",
  cacao_nacional: "#8B4513",
  cacao_giz: "#D2691E",
  cacao_ccn: "#CD853F",
  reforestation: "#66BB6A",
  pasture: "#FDD835",
};

export const HEIGHT_CLASS_LABELS: Record<string, string> = {
  "10_20": "10-20m",
  "20_30": "20-30m",
  "over_30": ">30m",
};

export const UNDERSTORY_LABELS: Record<string, string> = {
  open: "Abierto",
  moderate: "Moderado",
  dense: "Denso",
};

export const SLOPE_LABELS: Record<string, string> = {
  flat: "Plano",
  slight: "Leve",
  moderate: "Moderado",
};

export const DISTURBANCE_LABELS: Record<string, string> = {
  none: "Ninguno",
  cattle: "Ganado",
  logging: "Tala",
  trails: "Senderos",
};
