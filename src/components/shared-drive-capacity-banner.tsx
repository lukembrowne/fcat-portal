import "server-only";

import type { AuthUser } from "@/lib/types";
import { getSharedDriveCapacityAlerts } from "@/lib/shared-drives";
import { CapacityBannerClient } from "./shared-drive-capacity-banner-client";

/**
 * Site-wide banner shown to super-admins when any Shared Drive is approaching
 * its 500K item cap (or a project needs a new drive). Renders nothing when all
 * drives are healthy or the viewer isn't an admin. Mounted in the root layout.
 */
export function SharedDriveCapacityBanner({ user }: { user: AuthUser }) {
  if (user.globalRole !== "super_admin") return null;

  const alerts = getSharedDriveCapacityAlerts();
  if (alerts.drives.length === 0 && alerts.provisionProjects.length === 0) {
    return null;
  }

  const parts: string[] = [];
  let trashHint = false;
  if (alerts.drives.length > 0) {
    const top = alerts.drives[0];
    parts.push(`${top.name} al ${(top.fillPct * 100).toFixed(0)}%`);
    if (top.trashedCount > 0) trashHint = true;
    if (alerts.drives.length > 1) {
      parts.push(`+${alerts.drives.length - 1} drive(s) más`);
    }
  }
  if (alerts.provisionProjects.length > 0) {
    parts.push(
      `${alerts.provisionProjects.length} proyecto(s) por aprovisionar`,
    );
  }

  const message = parts.join(" · ");
  // Dismiss key: re-show if severity or the headline fill changes.
  const topFill = alerts.drives[0]?.fillPct ?? 0;
  const signature = `${alerts.hasCritical ? "crit" : "warn"}:${Math.round(topFill * 100)}:${alerts.drives.length}:${alerts.provisionProjects.length}`;

  return (
    <CapacityBannerClient
      critical={alerts.hasCritical}
      message={message}
      trashHint={trashHint}
      signature={signature}
    />
  );
}
