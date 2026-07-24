"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { species, identifications } from "@/db/schema";
import { eq, sql, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordEvent } from "@/lib/system-events";
import type { ActionResult } from "@/lib/types";
import type { Species } from "@/db/schema";
import {
  SPECIES_CONTENT_MAX,
  type SpeciesContentRow,
} from "./content-types";

/**
 * All species with their public finca-page content, ordered so the species
 * that actually show up on finca pages (any verified detection) come first,
 * then alphabetically by display name. Editor-gated (biochoco).
 */
export async function fetchSpeciesContentList(): Promise<SpeciesContentRow[]> {
  await requirePermission("biochoco", "editor");

  const speciesRows = await db.select().from(species);

  // Detection counts keyed by effective (corrected-or-original) scientific name.
  const counts = await db
    .select({
      name: sql<string>`coalesce(${identifications.correctedSpecies}, ${identifications.species})`,
      count: sql<number>`count(*)`,
    })
    .from(identifications)
    .where(
      inArray(identifications.verificationStatus, ["verified", "corrected"])
    )
    .groupBy(
      sql`coalesce(${identifications.correctedSpecies}, ${identifications.species})`
    );

  const countMap = new Map(counts.map((c) => [c.name, Number(c.count)]));

  return speciesRows
    .map((s) => ({
      id: s.id,
      scientificName: s.scientificName,
      commonName: s.commonName,
      spanishName: s.spanishName,
      type: s.type,
      publicContent: s.publicContent,
      detectionCount: countMap.get(s.scientificName) ?? 0,
      hasContent: !!s.publicContent?.trim(),
    }))
    .sort((a, b) => {
      const aSeen = a.detectionCount > 0 ? 1 : 0;
      const bSeen = b.detectionCount > 0 ? 1 : 0;
      if (aSeen !== bSeen) return bSeen - aSeen;
      const an = (a.spanishName || a.commonName || a.scientificName).toLowerCase();
      const bn = (b.spanishName || b.commonName || b.scientificName).toLowerCase();
      return an.localeCompare(bn);
    });
}

/**
 * Save the public content for one species. Global — this content is the same on
 * every finca page that shows the species, so a single edit propagates
 * everywhere. Editor-gated (biochoco). Empty/whitespace is stored as NULL (not
 * ""), which is the "no content" signal the public page reads.
 */
export async function updateSpeciesContent(
  id: number,
  data: { publicContent: string | null }
): Promise<ActionResult<Species>> {
  const user = await requirePermission("biochoco", "editor");

  try {
    const content = data.publicContent?.trim() || null;

    if ((content?.length ?? 0) > SPECIES_CONTENT_MAX) {
      return {
        success: false,
        error: `El texto no puede superar los ${SPECIES_CONTENT_MAX} caracteres.`,
      };
    }

    const [updated] = await db
      .update(species)
      .set({ publicContent: content })
      .where(eq(species.id, id))
      .returning();

    if (!updated) {
      return { success: false, error: "Especie no encontrada" };
    }

    await recordEvent({
      source: "biochoco-resultados",
      eventType: "update_species_content",
      summary: `Ficha de especie actualizada: ${
        updated.spanishName || updated.commonName || updated.scientificName
      }`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "species",
      targetId: id,
    });

    revalidatePath("/biochoco/fichas-especies");
    return { success: true, data: updated };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al guardar la ficha",
    };
  }
}
