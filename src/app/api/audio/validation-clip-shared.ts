/**
 * Shared loading helper for the two validation-clip routes.
 *
 * Not a route itself — only `route.ts` files become endpoints in the App
 * Router, so this sits alongside them without being reachable.
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  audioDetections,
  audioFiles,
  audioIdentifications,
  birdnetValidationSamples,
} from "@/db/schema";
import type { ClipSource } from "@/lib/birdnet-validation/clip-cache";

export interface ResolvedClipSource extends ClipSource {
  deploymentId: number | null;
}

/**
 * Resolve a sample id to everything needed to cut its clip.
 *
 * Join chain is sample -> identification -> detection -> file. The sample row
 * points at an IDENTIFICATION, not a detection; going straight to
 * `audio_detections` would join on an unrelated id space and silently return
 * the wrong clip.
 *
 * The time bounds come from `audio_detections` rather than the sample row: the
 * sample snapshots confidence and site (which must not drift), but the window
 * belongs to the detection and is stable.
 */
export async function loadClipSource(
  sampleId: number
): Promise<ResolvedClipSource | null> {
  const [row] = await db
    .select({
      sampleId: birdnetValidationSamples.id,
      driveFileId: audioFiles.driveFileId,
      deploymentId: audioFiles.deploymentId,
      duration: audioFiles.duration,
      startTime: audioDetections.startTime,
      endTime: audioDetections.endTime,
    })
    .from(birdnetValidationSamples)
    .innerJoin(
      audioIdentifications,
      eq(audioIdentifications.id, birdnetValidationSamples.audioIdentificationId)
    )
    .innerJoin(
      audioDetections,
      eq(audioDetections.id, audioIdentifications.audioDetectionId)
    )
    .innerJoin(audioFiles, eq(audioFiles.id, audioDetections.audioFileId))
    .where(eq(birdnetValidationSamples.id, sampleId));

  if (!row || !row.driveFileId) return null;

  return {
    sampleId: row.sampleId,
    driveFileId: row.driveFileId,
    startTime: row.startTime,
    endTime: row.endTime,
    duration: row.duration,
    deploymentId: row.deploymentId,
  };
}
