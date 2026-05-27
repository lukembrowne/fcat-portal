import { cache } from "react";
import { fetchEntities } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_DATASET_SITES,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import { log } from "@/lib/log";

export type HabitatMap = Map<string, string>;

/**
 * site_id → habitat_type lookup built from ODK BioChoco site entities.
 * Keys cover site_id, site_name, and label so different deployment naming
 * conventions all resolve. Returns an empty map on ODK failure so callers
 * can degrade gracefully (unmapped deployments land in the "unknown" bucket).
 *
 * Wrapped in `React.cache` so concurrent server-side callers in the same
 * request share one ODK round-trip. The dashboard "Por hábitat" tab issues
 * four parallel aggregator calls that all need this map.
 */
export const loadSiteHabitatMap = cache(async (): Promise<HabitatMap> => {
  try {
    const sites = await fetchEntities<OdkSiteEntity>(
      BIOCHOCO_PROJECT_ID,
      BIOCHOCO_DATASET_SITES,
      { tags: ["biochoco-sites"] },
    );
    const map: HabitatMap = new Map();
    for (const site of sites) {
      if (!site.habitat_type) continue;
      if (site.site_id) map.set(site.site_id, site.habitat_type);
      if (site.site_name) map.set(site.site_name, site.habitat_type);
      if (site.label && site.label !== site.site_name) {
        map.set(site.label, site.habitat_type);
      }
    }
    return map;
  } catch (err) {
    log.warn({ err }, "[habitat-lookup] ODK habitat map unavailable");
    return new Map();
  }
});

/** Pull "SEC-006" out of "SEC-006_V1". Returns null when there's no version suffix. */
export function extractSiteIdFromDeploymentName(
  deploymentName: string,
): string | null {
  const match = deploymentName.match(/^(.+?)_V\d+$/i);
  return match ? match[1] : null;
}

export interface HabitatResolveInput {
  siteName: string | null | undefined;
  deploymentName: string;
}

export const UNKNOWN_HABITAT_KEY = "unknown";

/**
 * Resolve a deployment's habitat key using the fallback chain:
 *   siteName → extracted site_id → "unknown"
 *
 * Use {@link loadSiteHabitatMap} to build the map once per request and pass
 * it to every call site for consistency across dashboard sections.
 */
export function resolveHabitatForDeployment(
  input: HabitatResolveInput,
  map: HabitatMap,
): string {
  const fromSiteName = input.siteName ? map.get(input.siteName) : undefined;
  if (fromSiteName) return fromSiteName;
  const extracted = extractSiteIdFromDeploymentName(input.deploymentName);
  if (extracted) {
    const fromExtracted = map.get(extracted);
    if (fromExtracted) return fromExtracted;
  }
  return UNKNOWN_HABITAT_KEY;
}
