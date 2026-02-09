"use server";

import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import { loadSchedule } from "@/lib/sheets-client";
import type { OdkSiteEntity } from "@/lib/odk-types";
import type { BiochocoOverviewData, SiteInfo } from "./types";

export async function fetchBiochocoData(): Promise<{
  success: boolean;
  data: BiochocoOverviewData;
  error?: string;
}> {
  try {
    const [schedule, rawSites, rawDeploys, rawRetrieves] = await Promise.all([
      loadSchedule(),
      fetchEntities<OdkSiteEntity>("8", "monitoring_sites_v0_14"),
      fetchSubmissions<Record<string, unknown>>("8", "instalar_sensores"),
      fetchSubmissions<Record<string, unknown>>("8", "retrieve_sensors"),
    ]);

    // Transform sites
    const sites: SiteInfo[] = rawSites.map((s) => ({
      siteId: s.site_id ?? s.label ?? "",
      siteName: s.label ?? s.site_name ?? "",
      habitatType: s.habitat_type ?? "",
      lat: s.latitude ? parseFloat(String(s.latitude)) : null,
      lng: s.longitude ? parseFloat(String(s.longitude)) : null,
    }));

    // Extract deployment_ids from form submissions
    // ODK groups come as nested objects in OData
    const deployedIds = rawDeploys
      .map((sub) => {
        const sel = sub.site_selection as Record<string, unknown> | undefined;
        return (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
      })
      .filter(Boolean);

    const retrievedIds = rawRetrieves
      .map((sub) => {
        const sel = sub.site_selection as Record<string, unknown> | undefined;
        return (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
      })
      .filter(Boolean);

    return {
      success: true,
      data: { schedule, sites, deployedIds, retrievedIds },
    };
  } catch (err) {
    console.error("Failed to fetch BioChoco data:", err);
    return {
      success: false,
      data: { schedule: [], sites: [], deployedIds: [], retrievedIds: [] },
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
