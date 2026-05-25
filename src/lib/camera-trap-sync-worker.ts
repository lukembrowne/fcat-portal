import "server-only";

import { db } from "@/db";
import { deployments, cameraTrapProjects, type Deployment } from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import {
  listDeploymentFolders,
  listDeploymentFoldersAcrossDrives,
  isValidFolderId,
} from "@/lib/drive-client";
import { getDiscoveryRootsForProject } from "@/lib/shared-drives";
import { CAMERA_TRAP_DRIVE_LAST_SYNC_KEY } from "@/lib/app-state-keys";
import { log } from "@/lib/log";
import {
  runDriveSyncWorkerGeneric,
  awaitJobTerminal,
} from "@/lib/drive-sync-worker-core";
import {
  scanDeploymentImagesInternal,
  refreshUploadCountsInternal,
  matchOdkDeploymentsInternal,
} from "@/lib/camera-trap-sync-internals";

export { awaitJobTerminal };

/**
 * Statuses where a human has already signed off on the deployment's
 * contents, so we skip the image re-scan to avoid muddying that sign-off.
 * Count refresh still runs so the dashboard stays current. Operators can
 * trigger a manual rescan from the per-row action menu when needed.
 */
const SKIP_RESCAN_STATUSES = new Set(["verified", "verified_empty"]);

/**
 * Run a camera-trap Drive sync job. Delegates the job lifecycle, fan-out, and
 * cancellation handling to the generic core; this module supplies the
 * camera-trap-specific discovery, deployment loading, per-deployment scan
 * (image scan + upload-count refresh), and ODK match.
 */
export async function runDriveSyncWorker(jobId: number): Promise<void> {
  return runDriveSyncWorkerGeneric<Deployment>(jobId, {
    jobType: "drive_sync",
    logTag: "drive-sync",
    revalidatePath: "/camera-trap",
    lastSyncStateKey: CAMERA_TRAP_DRIVE_LAST_SYNC_KEY,
    concurrencyEnvKey: "DRIVE_SYNC_CONCURRENCY",

    discover: async (job, signal) => {
      const projects = job.cameraTrapProjectId
        ? await db
            .select()
            .from(cameraTrapProjects)
            .where(eq(cameraTrapProjects.id, job.cameraTrapProjectId))
        : await db.select().from(cameraTrapProjects);

      const projectsToWalk = projects.filter(
        (p): p is typeof p & { driveFolderId: string } => !!p.driveFolderId
      );

      if (projectsToWalk.length === 0) {
        return {
          createdIds: [],
          earlyComplete: {
            statusMessage: "Sin proyectos con carpeta de Drive configurada",
          },
        };
      }

      const allCreatedIds: number[] = [];
      for (const proj of projectsToWalk) {
        if (await signal.isCancelled()) break;
        try {
          const roots = getDiscoveryRootsForProject(proj.driveFolderId);
          const driveFolders =
            roots.length === 1
              ? await listDeploymentFolders(roots[0])
              : await listDeploymentFoldersAcrossDrives(roots);
          const known = await db
            .select({ id: deployments.driveFolderId })
            .from(deployments)
            .where(eq(deployments.cameraTrapProjectId, proj.id));
          const knownSet = new Set(
            known.map((k) => k.id).filter((id): id is string => id != null)
          );

          for (const folder of driveFolders) {
            if (knownSet.has(folder.id)) continue;
            if (!isValidFolderId(folder.id)) continue;

            try {
              const [dep] = await db
                .insert(deployments)
                .values({
                  projectId: "camera-trap",
                  cameraTrapProjectId: proj.id,
                  name: folder.name.trim(),
                  driveFolderId: folder.id,
                  projectLabel: proj.name,
                  totalImages: 0,
                  status: "unscanned",
                  metadataSource: "drive",
                  createdBy: job.createdBy,
                })
                .returning();
              allCreatedIds.push(dep.id);
              knownSet.add(folder.id);
            } catch (err) {
              if (
                err instanceof Error &&
                err.message.includes("UNIQUE constraint failed")
              ) {
                continue;
              }
              log.warn(
                { err, name: folder.name, project: proj.name },
                "[drive-sync] Failed to insert deployment"
              );
            }
          }
        } catch (err) {
          log.error(
            { err, project: proj.name },
            "[drive-sync] Failed to list folders for project"
          );
        }
      }
      return { createdIds: allCreatedIds };
    },

    listDeployments: async (job) => {
      return job.cameraTrapProjectId
        ? await db
            .select()
            .from(deployments)
            .where(
              and(
                eq(deployments.cameraTrapProjectId, job.cameraTrapProjectId),
                isNotNull(deployments.driveFolderId)
              )
            )
        : await db
            .select()
            .from(deployments)
            .where(isNotNull(deployments.driveFolderId));
    },

    scanOne: async (dep) => {
      if (!SKIP_RESCAN_STATUSES.has(dep.status)) {
        await scanDeploymentImagesInternal(dep);
      }
      const r = await refreshUploadCountsInternal(dep);
      if (!r.ok) {
        throw new Error(r.error ?? "refresh failed");
      }
    },

    afterAll: async (createdIds) => {
      try {
        await matchOdkDeploymentsInternal(createdIds);
      } catch (err) {
        log.error({ err }, "[drive-sync] ODK match failed");
      }
    },
  });
}
