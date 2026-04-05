"use server";

import { requirePermission } from "@/lib/auth";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import { BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES, BIOCHOCO_FORM_DEPLOY, BIOCHOCO_FORM_RETRIEVE } from "@/lib/odk-constants";
import { loadSchedule } from "@/lib/sheets-client";
import type { OdkSiteEntity } from "@/lib/odk-types";
import type { ActionResult } from "@/lib/types";
import type { BiochocoOverviewData, SiteInfo } from "./types";
import { db } from "@/db";
import { deployments } from "@/db/schema";

export async function fetchBiochocoData(): Promise<ActionResult<BiochocoOverviewData>> {
  try {
    await requirePermission("biochoco", "viewer");
    const [schedule, rawSites, rawDeploys, rawRetrieves] = await Promise.all([
      loadSchedule(),
      fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
      fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_DEPLOY),
      fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_RETRIEVE),
    ]);

    // Enrich schedule with DB data (Drive folder links + field notes)
    const dbDeployments = await db
      .select({
        name: deployments.name,
        driveFolderId: deployments.driveFolderId,
        fieldNotes: deployments.fieldNotes,
      })
      .from(deployments);

    const dbMap = new Map(
      dbDeployments.map((d) => [d.name, d])
    );

    for (const row of schedule) {
      const dbRow = dbMap.get(row.deploymentId);
      if (dbRow?.driveFolderId) {
        row.driveFolderLink = `https://drive.google.com/drive/folders/${dbRow.driveFolderId}`;
      }
      if (dbRow?.fieldNotes) {
        row.fieldNotes = dbRow.fieldNotes;
      }
    }

    // Transform sites
    const sites: SiteInfo[] = rawSites.map((s) => ({
      siteId: s.site_id ?? s.label ?? "",
      siteName: s.label ?? s.site_name ?? "",
      habitatType: s.habitat_type ?? "",
      lat: s.latitude ? parseFloat(String(s.latitude)) : null,
      lng: s.longitude ? parseFloat(String(s.longitude)) : null,
      habitatAssessed: (s.habitat_assessed as string) ?? "",
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
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
