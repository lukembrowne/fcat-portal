"use server";

/**
 * Bulk species import: preview, then commit.
 *
 * Follows the finance importers' preview→commit shape
 * (src/app/finance/data/sueldos-import-card.tsx). Resolving and creating in one
 * call would mean a misspelled name is discovered as a created-then-abandoned
 * row, and this commit also draws each species' full sample — real queries
 * against a 2.5M-row table plus ODK — so an unreviewed commit is expensive to
 * undo.
 */

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import * as XLSX from "xlsx";

import { db } from "@/db";
import { birdnetValidationCampaigns, species as speciesTable } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { getUserCameraTrapProjects } from "@/lib/camera-trap-auth";
import { drawSampleCore } from "@/lib/birdnet-validation/sample-core";
import { log } from "@/lib/log";
import type { ActionResult } from "@/lib/types";
import { listValidatableSpecies, type ValidatableSpecies } from "./actions";
import {
  parseSpeciesList,
  resolveSpeciesRows,
  COMMIT_CHUNK_SIZE,
  type ImportOutcome,
  type ResolvedImportRow,
} from "./species-import";

export interface SpeciesImportPreview {
  rows: ResolvedImportRow[];
  totalFound: number;
  counts: Record<ImportOutcome, number>;
}

export interface SpeciesImportCommitRow {
  scientificName: string;
  created: boolean;
  /** Clips drawn, or null when the draw did not run. */
  drawn: number | null;
  /** Spanish reason when the species was created but its draw did not run. */
  error: string | null;
}

/**
 * Catalog extended with species that exist but have no accessible detections.
 *
 * `listValidatableSpecies` is derived from `audio_identifications`, so a real
 * species with no detections simply does not appear there. Without these extra
 * zero-count entries, pasting "Panthera onca" would report "no reconocida" —
 * indistinguishable from a typo — instead of "sin detecciones".
 */
async function extendedCatalog(): Promise<ValidatableSpecies[]> {
  const detected = await listValidatableSpecies();
  if (!detected.success) throw new Error(detected.error);

  const known = new Set(detected.data.map((s) => s.scientificName));
  const all = await db
    .select({
      scientificName: speciesTable.scientificName,
      commonName: speciesTable.commonName,
      spanishName: speciesTable.spanishName,
    })
    .from(speciesTable);

  const undetected: ValidatableSpecies[] = all
    .filter((s) => !known.has(s.scientificName))
    .map((s) => ({
      scientificName: s.scientificName,
      commonName: s.commonName,
      spanishName: s.spanishName,
      detectionCount: 0,
      activeStatus: null,
    }));

  return [...detected.data, ...undetected];
}

function tally(rows: ResolvedImportRow[]): Record<ImportOutcome, number> {
  const counts: Record<ImportOutcome, number> = {
    ready: 0,
    duplicate: 0,
    no_detections: 0,
    unknown: 0,
    repeated: 0,
  };
  for (const row of rows) counts[row.outcome]++;
  return counts;
}

async function buildPreview(text: string): Promise<SpeciesImportPreview> {
  const parsed = parseSpeciesList(text);
  // Surfaced as a refusal rather than a trimmed preview: a shortened list that
  // looks fine is how someone imports the wrong 2000 rows without noticing.
  if (parsed.tooLarge) throw new Error(parsed.tooLarge);

  const rows = resolveSpeciesRows(parsed.names, await extendedCatalog());
  return { rows, totalFound: parsed.totalFound, counts: tally(rows) };
}

/** Resolve pasted text without creating anything. */
export async function previewSpeciesImport(
  text: string
): Promise<ActionResult<SpeciesImportPreview>> {
  await requirePermission("grabaciones", "editor");
  try {
    return { success: true, data: await buildPreview(text) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al leer la lista",
    };
  }
}

/**
 * Same preview, from an uploaded file.
 *
 * Only the first column of the first sheet is read. A spreadsheet of species
 * names has no other meaningful shape, and guessing at column semantics is how
 * importers become unpredictable.
 */
export async function previewSpeciesImportFile(
  formData: FormData
): Promise<ActionResult<SpeciesImportPreview>> {
  await requirePermission("grabaciones", "editor");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { success: false, error: "Selecciona un archivo" };
  }

  try {
    const name = file.name.toLowerCase();
    let text: string;

    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) return { success: false, error: "El archivo no tiene hojas" };
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
      text = grid
        .map((row) => (Array.isArray(row) ? String(row[0] ?? "") : ""))
        .join("\n");
    } else {
      text = await file.text();
    }

    return { success: true, data: await buildPreview(text) };
  } catch (error) {
    log.warn({ err: error }, "[birdnet-validation] species import file unreadable");
    return { success: false, error: "No se pudo leer el archivo" };
  }
}

/**
 * Create each species in ONE CHUNK of an import and draw its sample.
 *
 * The caller walks the full list in `COMMIT_CHUNK_SIZE` slices — this action
 * deliberately refuses a larger array rather than accepting it and running for
 * minutes, because each species costs a real stratified draw against a 2.5M-row
 * table (1.4-2.0 s, see `sample-core.ts`) and the request would be killed
 * part-way with no record of how far it got. Chunking is safe precisely because
 * the per-species isolation below means a slice boundary is never a rollback
 * boundary.
 *
 * Re-resolves server-side rather than trusting the preview the client is
 * holding: a species can be created by someone else between preview and
 * commit, and the client's classification is not authoritative anyway.
 *
 * Fault-isolated per species — a failing draw leaves that species created and
 * reported, and the loop continues. Rolling the batch back on one ODK hiccup
 * would waste the whole import.
 */
export async function commitSpeciesImport(
  scientificNames: string[]
): Promise<ActionResult<SpeciesImportCommitRow[]>> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    if (scientificNames.length === 0) {
      return { success: false, error: "No hay especies para añadir" };
    }
    if (scientificNames.length > COMMIT_CHUNK_SIZE) {
      return {
        success: false,
        error: `Máximo ${COMMIT_CHUNK_SIZE} especies por solicitud`,
      };
    }

    const catalog = await extendedCatalog();
    const bySpecies = new Map(catalog.map((s) => [s.scientificName, s]));
    const ctProjects = await getUserCameraTrapProjects(user);
    const results: SpeciesImportCommitRow[] = [];

    for (const scientificName of scientificNames) {
      const sp = bySpecies.get(scientificName);

      if (!sp || sp.detectionCount <= 0) {
        results.push({
          scientificName,
          created: false,
          drawn: null,
          error: "Sin detecciones accesibles",
        });
        continue;
      }
      // Re-checked here, not just at preview: another editor may have started
      // this species in between.
      if (sp.activeStatus != null) {
        results.push({
          scientificName,
          created: false,
          drawn: null,
          error: "Ya se está validando",
        });
        continue;
      }

      let campaignId: number;
      try {
        const [created] = await db
          .insert(birdnetValidationCampaigns)
          .values({
            species: scientificName,
            ctProjectId: null,
            seed: Math.floor(Math.random() * 2147483647),
            createdBy: user.email,
          })
          .returning();
        campaignId = created.id;
      } catch (error) {
        results.push({
          scientificName,
          created: false,
          drawn: null,
          error:
            String(error).includes("UNIQUE constraint")
              ? "Ya se está validando"
              : "No se pudo crear",
        });
        continue;
      }

      // A failing draw must not undo the row or stop the batch: the species is
      // created and its draw can be re-run from its row.
      try {
        const [campaign] = await db
          .select()
          .from(birdnetValidationCampaigns)
          .where(
            and(
              eq(birdnetValidationCampaigns.id, campaignId),
              isNull(birdnetValidationCampaigns.abandonedReason)
            )
          );
        const { inserted } = await drawSampleCore(campaign, ctProjects);
        results.push({ scientificName, created: true, drawn: inserted, error: null });
      } catch (error) {
        results.push({
          scientificName,
          created: true,
          drawn: null,
          error:
            error instanceof Error ? error.message : "No se pudo extraer la muestra",
        });
      }
    }

    revalidatePath("/audio/validacion");
    return { success: true, data: results };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al añadir las especies",
    };
  }
}
