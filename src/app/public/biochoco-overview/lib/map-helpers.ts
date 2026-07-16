/**
 * Pure helpers for the overview map — kept out of the client component so they
 * can be unit-tested in the repo's node test environment (no DOM / Leaflet).
 */

import { HABITAT, HAB_ORDER, type HabitatKey } from "./habitat";

/** Resolve a deployment's habitat to its marker color, falling back to unknown. */
export function markerColor(habitat: string): string {
  return (HABITAT[habitat as HabitatKey] ?? HABITAT.unknown).color;
}

/** Habitats to show in the legend: those with at least one site, in gradient order. */
export function legendRows(habitatCounts: Record<string, number>): HabitatKey[] {
  return HAB_ORDER.filter((k) => (habitatCounts[k] ?? 0) > 0);
}
