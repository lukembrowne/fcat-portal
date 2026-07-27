/**
 * Habitat reference data for the BioChoco overview.
 *
 * Ported verbatim from the standalone report's `HAB` / `HAB_DESC` / `HAB_ORDER`
 * constants (~/Desktop/BioChoco-Collaborator-Report.html). Colors and English
 * names/descriptions are the exact source values; Spanish is drafted to match.
 *
 * The site → habitat map is not in the DB (it comes from ODK habitat surveys and
 * is stable); it lives in `habitat-map.json` and is joined at snapshot-build time.
 *
 * No server-only import here — this module is shared with the client map and the
 * habitat cards.
 */

import type { Bilingual } from "./snapshot-types";
import rawHabitatMap from "./habitat-map.json";

export type HabitatKey =
  | "primary_forest"
  | "secondary_forest"
  | "cacao_nacional"
  | "cacao_giz"
  | "cacao_ccn"
  | "reforestation"
  | "pasture"
  | "unknown";

export interface HabitatMeta {
  color: string;
  name: Bilingual;
  description: Bilingual;
}

/** Canonical display order along the land-use gradient (matches the Desktop). */
export const HAB_ORDER: HabitatKey[] = [
  "primary_forest",
  "secondary_forest",
  "cacao_nacional",
  "cacao_giz",
  "cacao_ccn",
  "reforestation",
  "pasture",
];

export const HABITAT: Record<HabitatKey, HabitatMeta> = {
  primary_forest: {
    color: "#1b7a3d",
    name: { en: "Primary forest", es: "Bosque primario" },
    description: {
      en: "Relatively undisturbed old growth",
      es: "Bosque antiguo relativamente inalterado",
    },
  },
  secondary_forest: {
    color: "#4caf50",
    name: { en: "Secondary forest", es: "Bosque secundario" },
    description: {
      en: "5–30 years of regeneration",
      es: "5–30 años de regeneración",
    },
  },
  cacao_nacional: {
    color: "#8B4513",
    name: { en: "Cacao (Nacional)", es: "Cacao (Nacional)" },
    description: {
      en: "Mature shade-grown cacao, native variety",
      es: "Cacao maduro bajo sombra, variedad nativa",
    },
  },
  cacao_giz: {
    color: "#D2691E",
    name: { en: "Cacao (GIZ)", es: "Cacao (GIZ)" },
    description: {
      en: "Young shade-grown agroforestry, under 5 years",
      es: "Agroforestería joven bajo sombra, menos de 5 años",
    },
  },
  cacao_ccn: {
    color: "#CD853F",
    name: { en: "Cacao (CCN)", es: "Cacao (CCN)" },
    description: {
      en: "Full-sun cacao, no shade trees",
      es: "Cacao a pleno sol, sin árboles de sombra",
    },
  },
  reforestation: {
    color: "#66BB6A",
    name: { en: "Reforestation", es: "Reforestación" },
    description: {
      en: "Active restoration plantings as part of the Choconexion project",
      es: "Plantaciones activas de restauración como parte del proyecto Choconexión",
    },
  },
  pasture: {
    color: "#FDD835",
    name: { en: "Pasture", es: "Pastizal" },
    description: { en: "Open, grazed land", es: "Terreno abierto de pastoreo" },
  },
  unknown: {
    color: "#94a3b8",
    name: { en: "Unclassified", es: "Sin clasificar" },
    description: { en: "", es: "" },
  },
};

const HABITAT_MAP = rawHabitatMap as Record<string, HabitatKey>;

/** Resolve a site code (e.g. "PRI-001") to its habitat, or "unknown". */
export function habitatForSite(code: string): HabitatKey {
  return HABITAT_MAP[code] ?? "unknown";
}

/**
 * Count distinct sites per habitat. De-duplicates codes internally, so the
 * summed values equal the number of distinct sites (unmapped → "unknown").
 */
export function countSitesByHabitat(siteCodes: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of new Set(siteCodes)) {
    const hab = habitatForSite(code);
    counts[hab] = (counts[hab] ?? 0) + 1;
  }
  return counts;
}
