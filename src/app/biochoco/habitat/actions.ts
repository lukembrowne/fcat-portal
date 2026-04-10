"use server";

import { requirePermission } from "@/lib/auth";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_DATASET_SITES,
  BIOCHOCO_FORM_HABITAT,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import type { ActionResult } from "@/lib/types";
import type { SiteInfo } from "../overview/types";
import type { HabitatAssessment } from "./types";
import { log } from "@/lib/log";

interface HabitatDataResult {
  sites: SiteInfo[];
  assessments: HabitatAssessment[];
  assessedSiteIds: string[];
}

export async function fetchHabitatData(): Promise<
  ActionResult<HabitatDataResult>
> {
  try {
    await requirePermission("biochoco", "viewer");

    const [rawSites, rawSubmissions] = await Promise.all([
      fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
      fetchSubmissions<Record<string, unknown>>(
        BIOCHOCO_PROJECT_ID,
        BIOCHOCO_FORM_HABITAT,
        { flatten: true }
      ),
    ]);

    const sites: SiteInfo[] = rawSites.map((s) => ({
      siteId: s.site_id ?? s.label ?? "",
      siteName: s.label ?? s.site_name ?? "",
      habitatType: s.habitat_type ?? "",
      lat: s.latitude ? parseFloat(String(s.latitude)) : null,
      lng: s.longitude ? parseFloat(String(s.longitude)) : null,
      habitatAssessed: (s.habitat_assessed as string) ?? "",
    }));

    const assessments: HabitatAssessment[] = rawSubmissions.map((sub) => {
      const str = (key: string) => String(sub[key] ?? "");
      const num = (key: string) => {
        const v = sub[key];
        return typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0;
      };

      const instanceId = String(sub.__id ?? sub["__id"] ?? "");

      return {
        instanceId,
        siteId: str("site_selection_site_id"),
        siteName: str("site_selection_site_name"),
        habitatType: str("site_selection_habitat_type"),
        assessmentDate: str("site_selection_assessment_date"),
        canopyCoverPercent: num("canopy_section_canopy_cover_percent"),
        canopyHeightClass: str("height_section_canopy_height_class"),
        treesMedium: num("tree_section_trees_medium"),
        treesLarge: num("tree_section_trees_large"),
        understoryDensity: str("understory_section_understory_density"),
        slopeCategory: str("slope_section_slope_category"),
        distanceToEdgeM: num("edge_section_distance_to_edge_m"),
        adjacentHabitat: str("edge_section_adjacent_habitat"),
        disturbanceSigns: str("disturbance_signs"),
        habitatNotes: str("habitat_notes"),
        photoNorth: str("photo_section_photo_north"),
        photoEast: str("photo_section_photo_east"),
        photoSouth: str("photo_section_photo_south"),
        photoWest: str("photo_section_photo_west"),
        photoCanopy: str("photo_section_photo_canopy"),
      };
    });

    const assessedSiteIds = [
      ...new Set(assessments.map((a) => a.siteId).filter(Boolean)),
    ];

    return {
      success: true,
      data: { sites, assessments, assessedSiteIds },
    };
  } catch (err) {
    log.error({ err }, "Failed to fetch habitat data");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
