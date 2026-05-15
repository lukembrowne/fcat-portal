import { DIEL_PERIODS, type DielPeriod } from "@/lib/acoustic-indices";
import type { AcousticIndicesGroup } from "@/app/audio/actions";
import { getHabitatName } from "../../overview/types";
import { HABITAT_COLORS } from "../../habitat/types";

export const UNKNOWN_KEY = "unknown";

export interface HabitatFilterOption {
  key: string;
  label: string;
  color: string;
}

export function parseHabitats(
  raw: string | null,
  options: HabitatFilterOption[],
): Set<string> {
  if (!raw) return new Set();
  const valid = new Set(options.map((o) => o.key));
  const result = new Set<string>();
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (t && valid.has(t)) result.add(t);
  }
  return result;
}

export function parseDiel(
  raw: string | null,
  available: DielPeriod[],
): DielPeriod {
  if (!raw || !available.length) return available[0] ?? ("dawn" as DielPeriod);
  if ((available as readonly string[]).includes(raw)) return raw as DielPeriod;
  return available[0];
}

export function buildHabitatOption(habitatKey: string): HabitatFilterOption {
  return {
    key: habitatKey,
    label:
      habitatKey === UNKNOWN_KEY ? "Sin clasificar" : getHabitatName(habitatKey),
    color: HABITAT_COLORS[habitatKey] ?? "#94a3b8",
  };
}

/** True when a habitat should be visible given the current filter. */
export function habitatMatches(key: string, selected: Set<string>): boolean {
  if (selected.size === 0) return true;
  return selected.has(key);
}

/**
 * Wrapper convenience: parse from URL search-params input (which can be
 * `string | string[] | undefined` in App Router).
 */
export function parseHabitatsParam(
  rawParam: string | string[] | undefined,
  options: HabitatFilterOption[],
): Set<string> {
  const raw = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  return parseHabitats(raw ?? null, options);
}

export function parseDielParam(
  rawParam: string | string[] | undefined,
  available: DielPeriod[],
): DielPeriod {
  const raw = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  return parseDiel(raw ?? null, available);
}

/** Returns the canonical-ordered diel periods that have any data. */
export function dielPeriodsWithData(
  groups: AcousticIndicesGroup[],
): DielPeriod[] {
  const present = new Set<DielPeriod>();
  for (const g of groups) {
    if (g.points.length > 0) present.add(g.dielPeriod);
  }
  return DIEL_PERIODS.filter((d) => present.has(d));
}
