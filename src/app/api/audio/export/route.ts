/**
 * BirdNET detection CSV export.
 *
 * Usage:
 *   GET /api/audio/export?deployment=<id>&conf=<threshold>
 *
 * Threshold defaults to DEFAULT_CONFIDENCE_THRESHOLD (0.7) if omitted or
 * invalid. The exported CSV includes only identifications passing the
 * shared filter rule from src/lib/audio-confidence.ts, so the rows
 * match exactly what the user sees in the UI at the same threshold.
 *
 * The CSV's first line is a comment annotating the threshold:
 *   # confidence_threshold=0.70
 * The download filename embeds the threshold for filesystem-level
 * disambiguation (two exports at different thresholds never collide).
 */

import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  audioDetections,
  audioFiles,
  audioIdentifications,
  deployments,
} from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import {
  applySpeciesConfidenceFilter,
  formatThreshold,
  parseThresholdParam,
} from "@/lib/audio-confidence";
import { loadActiveSpeciesThresholds } from "@/lib/birdnet-validation/threshold-map";

export const dynamic = "force-dynamic";

function csvVal(val: string | number | null | undefined): string {
  if (val === null || val === undefined || val === "") return "";
  const str = String(val);
  return `"${str.replace(/"/g, '""')}"`;
}

export async function GET(request: NextRequest) {
  const user = await requirePermission("grabaciones", "viewer");

  const url = new URL(request.url);
  const deploymentParam = url.searchParams.get("deployment");
  if (!deploymentParam) {
    return NextResponse.json(
      { error: "deployment query param required" },
      { status: 400 }
    );
  }
  const deploymentId = parseInt(deploymentParam, 10);
  if (isNaN(deploymentId)) {
    return NextResponse.json(
      { error: "deployment must be a numeric id" },
      { status: 400 }
    );
  }

  await requireDeploymentAccess(user, deploymentId);

  const threshold = parseThresholdParam(url.searchParams.get("conf"));
  const speciesThresholds = await loadActiveSpeciesThresholds();
  const visible = applySpeciesConfidenceFilter(threshold, speciesThresholds);

  const [deployment] = await db
    .select({ name: deployments.name })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));

  if (!deployment) {
    return NextResponse.json({ error: "deployment not found" }, { status: 404 });
  }

  const rows = await db
    .select({
      detectionId: audioDetections.id,
      filename: audioFiles.filename,
      startTime: audioDetections.startTime,
      endTime: audioDetections.endTime,
      minFreq: audioDetections.minFreq,
      maxFreq: audioDetections.maxFreq,
      species: audioIdentifications.species,
      correctedSpecies: audioIdentifications.correctedSpecies,
      identificationConfidence: audioIdentifications.confidence,
      verificationStatus: audioIdentifications.verificationStatus,
      modelVersion: audioIdentifications.modelVersion,
      createdAt: audioDetections.createdAt,
    })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      eq(audioDetections.id, audioIdentifications.audioDetectionId)
    )
    .innerJoin(audioFiles, eq(audioFiles.id, audioDetections.audioFileId))
    .where(and(eq(audioFiles.deploymentId, deploymentId), visible))
    .orderBy(asc(audioFiles.filename), asc(audioDetections.startTime));

  const thresholdStr = formatThreshold(threshold);
  const today = new Date().toISOString().slice(0, 10);
  const confSlug = thresholdStr.replace(".", ""); // "0.70" → "070"
  const filename = `birdnet_dep${deploymentId}_conf${confSlug}_${today}.csv`;

  const headers = [
    "detection_id",
    "filename",
    "start_time_s",
    "end_time_s",
    "min_freq_hz",
    "max_freq_hz",
    "species_scientific",
    "corrected_species",
    "confidence",
    "verification_status",
    "model_version",
    "created_at",
  ];

  // Provenance for the per-species thresholds actually in force. Without this a
  // reader cannot tell which score cut-off produced any given row: the global
  // value in the line above applies only to species with no validated
  // threshold. Only species appearing in this export are listed, so the header
  // stays proportionate to the file.
  const exportedSpecies = new Set(rows.map((r) => r.species));
  const appliedHere = [...speciesThresholds.entries()]
    .filter(([species]) => exportedSpecies.has(species))
    .sort(([a], [b]) => a.localeCompare(b));

  const speciesThresholdLines =
    appliedHere.length > 0
      ? `# species_specific_thresholds=${appliedHere.length}\n` +
        appliedHere
          .map(([species, value]) => `#   ${species}=${value.toFixed(4)}\n`)
          .join("")
      : "# species_specific_thresholds=0\n";

  const body =
    `# confidence_threshold=${thresholdStr}\n` +
    speciesThresholdLines +
    `# generated=${new Date().toISOString()}\n` +
    `# deployment_id=${deploymentId}\n` +
    `# deployment_name=${deployment.name}\n` +
    "﻿" +
    headers.join(",") +
    "\n" +
    rows
      .map((r) =>
        [
          r.detectionId,
          r.filename,
          r.startTime,
          r.endTime,
          r.minFreq,
          r.maxFreq,
          r.species,
          r.correctedSpecies,
          r.identificationConfidence,
          r.verificationStatus,
          r.modelVersion,
          r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        ]
          .map(csvVal)
          .join(",")
      )
      .join("\n");

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
