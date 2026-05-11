import { requirePermission } from "@/lib/auth";
import { getAppStateTimestamp } from "@/lib/app-state";
import { AUDIO_DRIVE_LAST_SYNC_KEY } from "@/lib/app-state-keys";
import {
  fetchAudioDeployments,
  fetchDistinctAudioProjects,
} from "./actions";
import type { AudioDeploymentRow } from "./actions";
import { AudioDeploymentsShell } from "./audio-deployments-shell";

export interface AudioProjectGroup {
  projectLabel: string;
  deployments: AudioDeploymentRow[];
  totalCount: number;
  actionableCount: number;
}

function groupByProject(deployments: AudioDeploymentRow[]): AudioProjectGroup[] {
  const groups = new Map<string, AudioDeploymentRow[]>();

  for (const d of deployments) {
    const key = d.ctProjectName || "Sin Proyecto";
    const existing = groups.get(key);
    if (existing) {
      existing.push(d);
    } else {
      groups.set(key, [d]);
    }
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([projectLabel, deps]) => ({
      projectLabel,
      deployments: deps,
      totalCount: deps.length,
      actionableCount: deps.filter((d) =>
        ["unscanned", "scanned", "birdnet_processing", "analyzed"].includes(d.displayStatus)
      ).length,
    }));
}

function computeStatusCounts(deployments: AudioDeploymentRow[]) {
  let sinEscanear = 0;
  let escaneados = 0;
  let procesando = 0;
  let porRevisar = 0;
  let revisados = 0;

  for (const d of deployments) {
    switch (d.displayStatus) {
      case "unscanned":
        sinEscanear++;
        break;
      case "scanned":
        escaneados++;
        break;
      case "birdnet_processing":
        procesando++;
        break;
      case "analyzed":
        porRevisar++;
        break;
      case "reviewed":
        revisados++;
        break;
    }
  }

  return { sinEscanear, escaneados, procesando, porRevisar, revisados };
}

export default async function AudioPage() {
  const user = await requirePermission("grabaciones", "viewer");

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "grabaciones" &&
        (p.role === "editor" || p.role === "admin")
    );

  const [deploymentsResult, distinctProjects, lastSyncAt] = await Promise.all([
    fetchAudioDeployments(),
    fetchDistinctAudioProjects(),
    getAppStateTimestamp(AUDIO_DRIVE_LAST_SYNC_KEY),
  ]);

  const allDeployments = deploymentsResult.success ? deploymentsResult.data : [];
  const groups = groupByProject(allDeployments);
  const counts = computeStatusCounts(allDeployments);

  return (
    <AudioDeploymentsShell
      groups={groups}
      deployments={allDeployments}
      counts={counts}
      distinctProjects={distinctProjects}
      isEditor={isEditor}
      lastSyncAt={lastSyncAt ? lastSyncAt.toISOString() : null}
    />
  );
}
