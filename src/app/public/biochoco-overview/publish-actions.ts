"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { recordEvent } from "@/lib/system-events";
import {
  saveReportSnapshot,
  BIOCHOCO_OVERVIEW_SLUG,
} from "@/lib/public-report-snapshot";
import { buildSnapshot } from "./lib/build-snapshot";
import { CURATED_AUDIO, CURATED_IMAGES } from "./curation";
import type { ActionResult } from "@/lib/types";

const ROUTE_PATH = "/public/biochoco-overview";

export interface PublishResult {
  generatedAt: string;
  imageCount: number;
  audioCount: number;
}

/**
 * Regenerate and publish the public BioChoco overview: recompute live stats,
 * resolve the curated media manifest, upsert the active snapshot, and refresh
 * the cached public route. Admin only. Records one system event on success.
 */
export async function publishBiochocoOverview(): Promise<ActionResult<PublishResult>> {
  const user = await requireAdmin();

  try {
    const generatedAt = new Date().toISOString();
    const snapshot = await buildSnapshot(
      { images: CURATED_IMAGES, audio: CURATED_AUDIO },
      { slug: BIOCHOCO_OVERVIEW_SLUG, generatedAt, generatedBy: user.email },
    );

    await saveReportSnapshot(snapshot);
    revalidatePath(ROUTE_PATH);

    await recordEvent({
      source: "biochoco-overview",
      eventType: "public_report_published",
      severity: "success",
      summary: `Página pública BioChoco publicada (${snapshot.images.length} fotos, ${snapshot.audio.length} audios)`,
      actorEmail: user.email,
      details: {
        deployments: snapshot.stats.retrievedCount,
        cameraSpecies: snapshot.stats.cameraRealSpecies,
        images: snapshot.images.length,
        audio: snapshot.audio.length,
      },
    });

    return {
      success: true,
      data: {
        generatedAt,
        imageCount: snapshot.images.length,
        audioCount: snapshot.audio.length,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "No se pudo publicar la página",
    };
  }
}
