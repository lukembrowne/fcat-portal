"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  audioFiles,
  audioDetections,
  audioIdentifications,
  species,
} from "@/db/schema";
import { eq, and, asc, desc, inArray, isNotNull, sql } from "drizzle-orm";
import {
  requireDeploymentAccess,
  getDeploymentIdForAudioDetection,
  getDeploymentIdForAudioIdentification,
} from "@/lib/camera-trap-auth";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";

// ---------------------------------------------------------------------------
// Read actions
// ---------------------------------------------------------------------------

export async function getAudioFileWithDetections(audioFileId: number) {
  await requirePermission("grabaciones", "viewer");

  const [file] = await db
    .select()
    .from(audioFiles)
    .where(eq(audioFiles.id, audioFileId));

  if (!file) return null;

  const dets = await db
    .select()
    .from(audioDetections)
    .where(eq(audioDetections.audioFileId, audioFileId))
    .orderBy(asc(audioDetections.startTime));

  const detections = await Promise.all(
    dets.map(async (det) => {
      const [ident] = await db
        .select()
        .from(audioIdentifications)
        .where(eq(audioIdentifications.audioDetectionId, det.id))
        .limit(1);

      return {
        ...det,
        identification: ident ?? null,
      };
    })
  );

  return { file, detections };
}

export async function getAudioFileIds(
  deploymentId: number
): Promise<number[]> {
  await requirePermission("grabaciones", "viewer");

  const files = await db
    .select({ id: audioFiles.id })
    .from(audioFiles)
    .where(eq(audioFiles.deploymentId, deploymentId))
    .orderBy(asc(audioFiles.filename));

  return files.map((f) => f.id);
}

// ---------------------------------------------------------------------------
// Mutation actions
// ---------------------------------------------------------------------------

export async function createAudioDetection(
  audioFileId: number,
  box: { startTime: number; endTime: number; minFreq: number; maxFreq: number }
): Promise<ActionResult<{ detectionId: number; identificationId: number }>> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const [file] = await db
      .select({ deploymentId: audioFiles.deploymentId })
      .from(audioFiles)
      .where(eq(audioFiles.id, audioFileId));

    if (!file) {
      return { success: false, error: "Archivo de audio no encontrado" };
    }

    await requireDeploymentAccess(user, file.deploymentId);

    const { startTime, endTime, minFreq, maxFreq } = box;
    if (startTime >= endTime || minFreq >= maxFreq) {
      return { success: false, error: "Coordenadas de detección inválidas" };
    }

    const [det] = await db
      .insert(audioDetections)
      .values({
        audioFileId,
        startTime,
        endTime,
        minFreq,
        maxFreq,
        confidence: 1.0,
        modelVersion: "manual",
        createdBy: user.email,
      })
      .returning();

    const [ident] = await db
      .insert(audioIdentifications)
      .values({
        audioDetectionId: det.id,
        species: "unknown",
        confidence: 1.0,
        modelVersion: "manual",
        verificationStatus: "unverified",
      })
      .returning();

    revalidatePath("/audio");
    return {
      success: true,
      data: { detectionId: det.id, identificationId: ident.id },
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Error al crear detección",
    };
  }
}

export async function updateAudioDetection(
  detectionId: number,
  box: { startTime: number; endTime: number; minFreq: number; maxFreq: number }
): Promise<ActionResult> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const depId = await getDeploymentIdForAudioDetection(detectionId);
    if (depId) await requireDeploymentAccess(user, depId);

    const { startTime, endTime, minFreq, maxFreq } = box;
    if (startTime >= endTime || minFreq >= maxFreq) {
      return { success: false, error: "Coordenadas de detección inválidas" };
    }

    await db
      .update(audioDetections)
      .set({ startTime, endTime, minFreq, maxFreq })
      .where(eq(audioDetections.id, detectionId));

    revalidatePath("/audio");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Error al actualizar detección",
    };
  }
}

export async function deleteAudioDetection(
  detectionId: number
): Promise<ActionResult> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const depId = await getDeploymentIdForAudioDetection(detectionId);
    if (depId) await requireDeploymentAccess(user, depId);

    await db
      .delete(audioDetections)
      .where(eq(audioDetections.id, detectionId));

    revalidatePath("/audio");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Error al eliminar detección",
    };
  }
}

export async function assignAudioSpecies(
  identificationId: number,
  newSpecies: string
): Promise<ActionResult> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const depId =
      await getDeploymentIdForAudioIdentification(identificationId);
    if (depId) await requireDeploymentAccess(user, depId);

    const [ident] = await db
      .select({
        id: audioIdentifications.id,
        species: audioIdentifications.species,
        verificationStatus: audioIdentifications.verificationStatus,
      })
      .from(audioIdentifications)
      .where(eq(audioIdentifications.id, identificationId));

    if (!ident) {
      return { success: false, error: "Identificación no encontrada" };
    }

    if (ident.verificationStatus === "rejected") {
      return {
        success: false,
        error: "No se puede asignar especie a una detección rechazada",
      };
    }

    // If species matches original → verify; otherwise → correct
    const isMatch = newSpecies === ident.species;

    await db
      .update(audioIdentifications)
      .set({
        verificationStatus: isMatch ? "verified" : "corrected",
        correctedSpecies: isMatch ? null : newSpecies,
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(eq(audioIdentifications.id, identificationId));

    revalidatePath("/audio");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Error al asignar especie",
    };
  }
}

export async function verifyAudioIdentification(
  identificationId: number
): Promise<ActionResult> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const depId =
      await getDeploymentIdForAudioIdentification(identificationId);
    if (depId) await requireDeploymentAccess(user, depId);

    await db
      .update(audioIdentifications)
      .set({
        verificationStatus: "verified",
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(
        and(
          eq(audioIdentifications.id, identificationId),
          eq(audioIdentifications.verificationStatus, "unverified")
        )
      );

    revalidatePath("/audio");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Error al verificar identificación",
    };
  }
}

export async function rejectAudioIdentification(
  identificationId: number
): Promise<ActionResult> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const depId =
      await getDeploymentIdForAudioIdentification(identificationId);
    if (depId) await requireDeploymentAccess(user, depId);

    await db
      .update(audioIdentifications)
      .set({
        verificationStatus: "rejected",
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(eq(audioIdentifications.id, identificationId));

    revalidatePath("/audio");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Error al rechazar identificación",
    };
  }
}

export async function verifyAllAudioAndAdvance(
  identificationIds: number[],
  deploymentId: number,
  currentFileId: number
): Promise<ActionResult<{ nextFileId: number | null }>> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    await requireDeploymentAccess(user, deploymentId);

    if (identificationIds.length > 0) {
      for (const id of identificationIds) {
        await db
          .update(audioIdentifications)
          .set({
            verificationStatus: "verified",
            verifiedBy: user.email,
            verifiedAt: new Date(),
          })
          .where(
            and(
              eq(audioIdentifications.id, id),
              eq(audioIdentifications.verificationStatus, "unverified")
            )
          );
      }
    }

    // Find next file with unverified detections — forward first
    const forward = await db
      .select({ id: audioFiles.id })
      .from(audioFiles)
      .innerJoin(
        audioDetections,
        eq(audioDetections.audioFileId, audioFiles.id)
      )
      .innerJoin(
        audioIdentifications,
        eq(audioIdentifications.audioDetectionId, audioDetections.id)
      )
      .where(
        and(
          eq(audioFiles.deploymentId, deploymentId),
          eq(audioIdentifications.verificationStatus, "unverified"),
          sql`${audioFiles.id} > ${currentFileId}`
        )
      )
      .orderBy(audioFiles.id)
      .limit(1);

    if (forward.length > 0) {
      revalidatePath("/audio");
      return { success: true, data: { nextFileId: forward[0].id } };
    }

    // Wrap around
    const wrapped = await db
      .select({ id: audioFiles.id })
      .from(audioFiles)
      .innerJoin(
        audioDetections,
        eq(audioDetections.audioFileId, audioFiles.id)
      )
      .innerJoin(
        audioIdentifications,
        eq(audioIdentifications.audioDetectionId, audioDetections.id)
      )
      .where(
        and(
          eq(audioFiles.deploymentId, deploymentId),
          eq(audioIdentifications.verificationStatus, "unverified"),
          sql`${audioFiles.id} != ${currentFileId}`
        )
      )
      .orderBy(audioFiles.id)
      .limit(1);

    revalidatePath("/audio");
    return {
      success: true,
      data: { nextFileId: wrapped.length > 0 ? wrapped[0].id : null },
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Error al verificar detecciones",
    };
  }
}

export async function getRecentAudioSpecies(
  deploymentId: number,
  limit = 8
): Promise<ActionResult<typeof species.$inferSelect[]>> {
  await requirePermission("grabaciones", "viewer");

  const recent = await db
    .selectDistinct({
      scientificName: audioIdentifications.correctedSpecies,
    })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      eq(audioDetections.id, audioIdentifications.audioDetectionId)
    )
    .innerJoin(
      audioFiles,
      eq(audioFiles.id, audioDetections.audioFileId)
    )
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        isNotNull(audioIdentifications.correctedSpecies)
      )
    )
    .limit(limit);

  const names = recent
    .map((r) => r.scientificName)
    .filter((n): n is string => n !== null);

  if (names.length === 0) {
    return { success: true, data: [] };
  }

  const result = await db
    .select()
    .from(species)
    .where(sql`${species.scientificName} IN (${sql.join(names.map(n => sql`${n}`), sql`, `)})`);

  return { success: true, data: result };
}

const FREQUENT_AUDIO_SPECIES_TYPE_ORDER = [
  "bird",
  "mammal",
  "amphibian",
  "reptile",
  "insect",
  "system",
];

/**
 * Frequent species for the audio annotation hotkey slots, mirroring the
 * camera-trap `getFrequentSpecies` shape. Scoped per deployment so that the
 * 1-9 keys reflect what's actually being identified at that site. Pads with
 * an alphabetical-by-type fallback so the slots are always full.
 */
export async function getFrequentAudioSpecies(
  deploymentId: number | null,
  limit = 9
): Promise<ActionResult<typeof species.$inferSelect[]>> {
  await requirePermission("grabaciones", "viewer");

  const coalesced = sql`COALESCE(
    NULLIF(TRIM(${audioIdentifications.correctedSpecies}), ''),
    NULLIF(TRIM(${audioIdentifications.species}), '')
  )`;

  const top = await db
    .select({
      id: species.id,
      scientificName: species.scientificName,
      commonName: species.commonName,
      spanishName: species.spanishName,
      type: species.type,
      taxonomicRank: species.taxonomicRank,
    })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      eq(audioDetections.id, audioIdentifications.audioDetectionId)
    )
    .innerJoin(audioFiles, eq(audioFiles.id, audioDetections.audioFileId))
    .innerJoin(species, sql`${species.scientificName} = ${coalesced}`)
    .where(
      and(
        inArray(audioIdentifications.verificationStatus, ["verified", "corrected"]),
        deploymentId !== null ? eq(audioFiles.deploymentId, deploymentId) : undefined
      )
    )
    .groupBy(coalesced)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  if (top.length < limit) {
    const seen = new Set(top.map((s) => s.scientificName));
    const allSpecies = await db
      .select({
        id: species.id,
        scientificName: species.scientificName,
        commonName: species.commonName,
        spanishName: species.spanishName,
        type: species.type,
        taxonomicRank: species.taxonomicRank,
      })
      .from(species);
    const typeRank = new Map(FREQUENT_AUDIO_SPECIES_TYPE_ORDER.map((t, i) => [t, i]));
    const fallback = allSpecies
      .filter((s) => !seen.has(s.scientificName))
      .sort((a, b) => {
        const ra = typeRank.get(a.type) ?? 999;
        const rb = typeRank.get(b.type) ?? 999;
        return ra !== rb ? ra - rb : a.scientificName.localeCompare(b.scientificName);
      })
      .slice(0, limit - top.length);
    top.push(...fallback);
  }

  return { success: true, data: top as typeof species.$inferSelect[] };
}
