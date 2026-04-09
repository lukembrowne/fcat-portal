/**
 * Shared loader for the ODK-reported deployment window (install / retrieve
 * datetimes) used by iButton, camera-trap, and audio QC.
 *
 * The window is the ground truth for when a sensor (any modality) was
 * physically deployed at a site. Originally lived in
 * `src/app/biochoco/ibutton/actions.ts`; lifted here so the camera-trap and
 * audio modules can compute coverage / out-of-window checks against the same
 * source.
 */

import { fetchSubmissions } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_FORM_DEPLOY,
  BIOCHOCO_FORM_RETRIEVE,
} from "@/lib/odk-constants";

/** Strip TZ offset and milliseconds from ODK time: "09:20:00.000-05:00" → "09:20:00" */
function cleanOdkTime(raw: string): string {
  return raw.replace(/\.\d{3}.*$/, "");
}

/** An ODK-recorded install/retrieve timestamp plus whether the time of day
 *  came from the submission (`true`) or was padded to 00:00:00 / 23:59:59
 *  because ODK recorded only the date (`false`). */
export type OdkDateTime = { dt: string; timeKnown: boolean };

/** Build deploy/retrieve datetime maps from ODK submissions.
 *  Values are "YYYY-MM-DD HH:mm:ss" for timestamp-level truncation. */
export async function loadOdkDateTimes(): Promise<{
  deployDateTimeMap: Map<string, OdkDateTime>;
  retrieveDateTimeMap: Map<string, OdkDateTime>;
}> {
  const [rawDeploys, rawRetrieves] = await Promise.all([
    fetchSubmissions<Record<string, unknown>>(
      BIOCHOCO_PROJECT_ID,
      BIOCHOCO_FORM_DEPLOY
    ),
    fetchSubmissions<Record<string, unknown>>(
      BIOCHOCO_PROJECT_ID,
      BIOCHOCO_FORM_RETRIEVE
    ),
  ]);

  const deployDateTimeMap = new Map<string, OdkDateTime>();
  for (const sub of rawDeploys) {
    const sel = sub.site_selection as Record<string, unknown> | undefined;
    const depInfo = sub.deployment_info as Record<string, unknown> | undefined;
    const depId =
      (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
    if (!depId) continue;
    const date =
      (depInfo?.deploy_date as string) ??
      (sel?.fecha_instalacion as string) ??
      (sub.fecha_instalacion as string) ??
      "";
    if (!date) continue;
    const time = (depInfo?.deploy_time as string) ?? "";
    const dateStr = date.slice(0, 10);
    // Fallback: if no time, use 00:00:00 (start of day = inclusive)
    const timeKnown = Boolean(time);
    const timeStr = time ? cleanOdkTime(time) : "00:00:00";
    deployDateTimeMap.set(depId, { dt: `${dateStr} ${timeStr}`, timeKnown });
  }

  const retrieveDateTimeMap = new Map<string, OdkDateTime>();
  for (const sub of rawRetrieves) {
    const sel = sub.site_selection as Record<string, unknown> | undefined;
    const retInfo = sub.retrieval_info as Record<string, unknown> | undefined;
    const depId =
      (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
    if (!depId) continue;
    const date =
      (retInfo?.retrieval_date as string) ??
      (sel?.fecha_recuperacion as string) ??
      (sub.fecha_recuperacion as string) ??
      "";
    if (!date) continue;
    const time = (retInfo?.retrieval_time as string) ?? "";
    const dateStr = date.slice(0, 10);
    // Fallback: if no time, use 23:59:59 (end of day = inclusive)
    const timeKnown = Boolean(time);
    const timeStr = time ? cleanOdkTime(time) : "23:59:59";
    retrieveDateTimeMap.set(depId, { dt: `${dateStr} ${timeStr}`, timeKnown });
  }

  return { deployDateTimeMap, retrieveDateTimeMap };
}
