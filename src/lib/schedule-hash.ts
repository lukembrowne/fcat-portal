import { createHash } from "crypto";
import type { ScheduleRow } from "@/lib/schedule-types";

/**
 * Compact hash of the schedule's identity-and-dates fields, used as the
 * optimistic-lock token for preview→commit flows. If the relevant fields
 * change between preview and commit, the hash changes and the commit is
 * rejected so the user can re-preview against fresh data.
 */
export function scheduleHash(rows: ScheduleRow[]): string {
  const content = JSON.stringify(
    rows.map((r) => [r.deploymentId, r.status, r.plannedDeployDate, r.plannedRetrieveDate]),
  );
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
