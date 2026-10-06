/**
 * CSV of BirdNET validation clips confirmed correct, ready to join to habitat.
 *
 * Usage:
 *   GET /api/audio/validation-export            every species the caller may see
 *   GET /api/audio/validation-export?species=X  one species
 *
 * Which answers count and the column set are documented in
 * `src/lib/birdnet-validation/correct-export.ts`. Viewer-gated like the review
 * page, and scoped to the caller's camera-trap projects.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getUserCameraTrapProjects } from "@/lib/camera-trap-auth";
import {
  buildCorrectDetectionsCsv,
  collectCorrectDetections,
  speciesHasValidation,
} from "@/lib/birdnet-validation/correct-export";
import { speciesSlug } from "@/lib/species-slug";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await requirePermission("grabaciones", "viewer");

  const speciesParam = new URL(request.url).searchParams.get("species");
  const species = speciesParam?.trim() || undefined;
  if (species !== undefined && !(await speciesHasValidation(species))) {
    return NextResponse.json({ error: "Especie sin validación" }, { status: 404 });
  }

  const ctProjects = await getUserCameraTrapProjects(user);
  const rows = await collectCorrectDetections({
    ctProjects,
    species,
  });

  const body = buildCorrectDetectionsCsv(rows);

  const today = new Date().toISOString().slice(0, 10);
  const filename = `birdnet_correctas_${species ? speciesSlug(species) : "todas"}_${today}.csv`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
