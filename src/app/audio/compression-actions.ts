"use server";

/**
 * Audio compression server actions — thin wrappers over `audio-compression-core`.
 *
 * The core lib is auth-agnostic so CLI scripts (`scripts/compress-all-audio.mjs`)
 * and future MCP tools can call it directly. These wrappers add `requirePermission`
 * + `revalidatePath` for the browser path.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import {
  enqueueAudioCompressionJob,
  enqueueAudioRevertJob,
  cancelAudioCompressionJob as coreCancel,
  getAudioCompressionPreview as corePreview,
  getAudioRevertPreview as coreRevertPreview,
} from "@/lib/audio-compression-core";
import type { ActionResult } from "@/lib/types";

const AUDIO_PATH = "/audio";

export async function compressDeploymentAudio(
  deploymentId: number,
  options?: { dryRun?: boolean },
): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("grabaciones", "admin");
  await requireDeploymentAccess(user, deploymentId);
  const result = await enqueueAudioCompressionJob({
    deploymentId,
    actorEmail: user.email,
    dryRun: options?.dryRun,
  });
  if (result.success) revalidatePath(AUDIO_PATH);
  return result;
}

export async function batchCompressDeploymentAudio(
  deploymentIds: number[],
  options?: { dryRun?: boolean },
): Promise<
  ActionResult<{ enqueued: number; refused: { id: number; reason: string }[] }>
> {
  const user = await requirePermission("grabaciones", "admin");
  const refused: { id: number; reason: string }[] = [];
  let enqueued = 0;
  for (const id of deploymentIds) {
    try {
      await requireDeploymentAccess(user, id);
    } catch {
      refused.push({ id, reason: "Sin acceso" });
      continue;
    }
    const r = await enqueueAudioCompressionJob({
      deploymentId: id,
      actorEmail: user.email,
      dryRun: options?.dryRun,
    });
    if (r.success) enqueued++;
    else refused.push({ id, reason: r.error });
  }
  if (enqueued > 0) revalidatePath(AUDIO_PATH);
  return { success: true, data: { enqueued, refused } };
}

export async function revertDeploymentAudioCompression(
  deploymentId: number,
): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("grabaciones", "admin");
  await requireDeploymentAccess(user, deploymentId);
  const result = await enqueueAudioRevertJob({
    deploymentId,
    actorEmail: user.email,
  });
  if (result.success) revalidatePath(AUDIO_PATH);
  return result;
}

export async function cancelAudioCompressionJobAction(
  jobId: number,
): Promise<ActionResult<void>> {
  const user = await requirePermission("grabaciones", "admin");
  return coreCancel({ jobId, actorEmail: user.email });
}

export async function getAudioCompressionPreviewAction(
  deploymentIds: number[],
): Promise<
  ActionResult<{
    count: number;
    totalSizeMB: number;
    estimatedSavedMB: number;
  }>
> {
  // Editor (not admin) — supports preview from headless dry-run discovery.
  await requirePermission("grabaciones", "editor");
  return corePreview(deploymentIds);
}

export async function getAudioRevertPreviewAction(
  deploymentId: number,
): Promise<ActionResult<{ count: number; reclaimableMB: number }>> {
  await requirePermission("grabaciones", "editor");
  return coreRevertPreview(deploymentId);
}
