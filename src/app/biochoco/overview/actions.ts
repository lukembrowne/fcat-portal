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
import { log } from "@/lib/log";

export async function fetchBiochocoData(): Promise<ActionResult<BiochocoOverviewData>> {
  try {
    await requirePermission("biochoco", "viewer");
    const [schedule, rawSites, rawDeploys, rawRetrieves] = await Promise.all([
      loadSchedule(),
      fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
      fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_DEPLOY),
      fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_RETRIEVE),
    ]);

    // Enrich schedule with DB data (Drive folder links + field notes).
    // Build new objects via spread (not in-place mutation) so all fields are
    // own enumerable properties on the serialized RSC payload.
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

    const enrichedSchedule = schedule.map((row) => {
      const dbRow = dbMap.get(row.deploymentId);
      return {
        ...row,
        driveFolderLink: dbRow?.driveFolderId
          ? `https://drive.google.com/drive/folders/${dbRow.driveFolderId}`
          : row.driveFolderLink,
        fieldNotes: dbRow?.fieldNotes ?? null,
      };
    });

    // Transform sites
    const sites: SiteInfo[] = rawSites.map((s) => ({
      siteId: s.site_id ?? s.label ?? "",
      siteName: s.label ?? s.site_name ?? "",
      habitatType: s.habitat_type ?? "",
      lat: s.latitude ? parseFloat(String(s.latitude)) : null,
      lng: s.longitude ? parseFloat(String(s.longitude)) : null,
      habitatAssessed: (s.habitat_assessed as string) ?? "",
    }));

    // Extract deployment_ids and actual dates from form submissions
    // ODK groups come as nested objects in OData
    const deployDateMap = new Map<string, string>();
    const deployedIds = rawDeploys
      .map((sub) => {
        const sel = sub.site_selection as Record<string, unknown> | undefined;
        const depInfo = sub.deployment_info as Record<string, unknown> | undefined;
        const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
        const date = (depInfo?.deploy_date as string) ?? (sel?.fecha_instalacion as string) ?? (sub.fecha_instalacion as string) ?? "";
        if (depId && date) deployDateMap.set(depId, date.slice(0, 10));
        return depId;
      })
      .filter(Boolean);

    const retrieveDateMap = new Map<string, string>();
    const retrievedIds = rawRetrieves
      .map((sub) => {
        const sel = sub.site_selection as Record<string, unknown> | undefined;
        const retInfo = sub.retrieval_info as Record<string, unknown> | undefined;
        const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
        const date = (retInfo?.retrieval_date as string) ?? (sel?.fecha_recuperacion as string) ?? (sub.fecha_recuperacion as string) ?? "";
        if (depId && date) retrieveDateMap.set(depId, date.slice(0, 10));
        return depId;
      })
      .filter(Boolean);

    // Enrich schedule with actual ODK dates
    const scheduleWithDates = enrichedSchedule.map((row) => ({
      ...row,
      actualDeployDate: deployDateMap.get(row.deploymentId) ?? row.actualDeployDate,
      actualRetrieveDate: retrieveDateMap.get(row.deploymentId) ?? row.actualRetrieveDate,
    }));

    return {
      success: true,
      data: { schedule: scheduleWithDates, sites, deployedIds, retrievedIds },
    };
  } catch (err) {
    log.error({ err }, "Failed to fetch BioChoco data");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
