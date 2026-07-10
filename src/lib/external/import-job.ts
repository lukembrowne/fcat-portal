/**
 * External-image import background job (e.g. LILA BC).
 *
 * Pipeline: resolve candidates (with LILA's PRECOMPUTED MegaDetector-RDE boxes)
 * → download frames (EXIF-scrubbed) → store a detection per box + a VERIFIED,
 * train-only identification + provenance. No detector runs here. Crops are
 * produced later by the normal training-export step (same sharp padding/
 * long-edge/jpeg), so external and FCAT crops share one crop distribution.
 *
 * Honest-eval invariant: every imported image lands on a synthetic, train-pinned
 * deployment (one per source dataset), so the exporter's deployment-level split
 * keeps external data out of val/test (see plan KTD4/KTD5).
 *
 * Boxes are MDv5a (RDE), not the portal's MDv6 — a negligible difference for
 * train-only augmentation, recorded in the detection's model version.
 */

import path from "node:path";
import pLimit from "p-limit";
import { eq, and, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  deployments,
  images,
  detections,
  identifications,
  externalImages,
  processingJobs,
  projects,
  species,
  type ProcessingJob,
} from "@/db/schema";
import { log } from "@/lib/log";
import {
  recordEvent,
  buildJobStartEvent,
  buildJobCompletionEvent,
} from "@/lib/system-events";
import {
  fetchLilaMetadata,
  fetchLilaTaxonomyMap,
  type DatasetConfig,
  type ImportCandidate,
} from "./lila-source";
import { externalCapForClass } from "./taxon-map";
import { EXTERNAL_DIR, downloadExternalFrame } from "./frame-cache";

/** Project the synthetic external deployments live under. */
const EXTERNAL_PROJECT_ID = "external-lila";
const EXTERNAL_PROJECT_NAME = "Datos externos (LILA)";

const DOWNLOAD_CONCURRENCY = Math.max(
  1,
  Number(process.env.CT_EXTERNAL_IMPORT_CONCURRENCY) || 8,
);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export interface DetectionLite {
  id: number;
  detectionClass: number;
  detectionConfidence: number;
}

/**
 * The single best ANIMAL detection (class 0) for an image — highest confidence,
 * id as a deterministic tiebreak. Returns null when the frame has no animal
 * detection (MegaDetector found nothing, or only person/vehicle).
 */
export function pickBestAnimalDetection(
  dets: DetectionLite[],
): DetectionLite | null {
  const animals = dets.filter((d) => d.detectionClass === 0);
  if (animals.length === 0) return null;
  return animals.reduce((best, d) =>
    d.detectionConfidence > best.detectionConfidence ||
    (d.detectionConfidence === best.detectionConfidence && d.id < best.id)
      ? d
      : best,
  );
}

/**
 * Per-class external cap: each requested class gets the flat
 * `externalCapForClass()`. Classes not requested are omitted (treated as cap 0
 * by the source selector, so they are never pulled).
 */
export function resolveCapByClass(
  requestedClasses: string[],
): Map<string, number> {
  const caps = new Map<string, number>();
  for (const cls of requestedClasses) {
    caps.set(cls, externalCapForClass());
  }
  return caps;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ExternalImportParams {
  datasets: DatasetConfig[];
  requestedClasses: string[];
  /** Optional LILA taxonomy mapping: source category → scientific binomial. */
  taxonomyMap?: Map<string, string>;
  createdBy: string;
}

function sanitizeFileStem(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

/** Find or create the project that owns external deployments. */
async function ensureExternalProject(): Promise<void> {
  const existing = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, EXTERNAL_PROJECT_ID))
    .get();
  if (!existing) {
    db.insert(projects)
      .values({ id: EXTERNAL_PROJECT_ID, name: EXTERNAL_PROJECT_NAME })
      .run();
  }
}

/** Find or create the synthetic train-pinned deployment for a source dataset. */
async function ensureExternalDeployment(dataset: DatasetConfig): Promise<number> {
  const name = `LILA: ${dataset.name}`;
  const existing = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.isExternal, true), eq(deployments.name, name)))
    .get();
  if (existing) return existing.id;
  const row = db
    .insert(deployments)
    .values({
      projectId: EXTERNAL_PROJECT_ID,
      name,
      status: "processed",
      isExternal: true,
      trainingSplit: "train",
      createdBy: "lila-import",
    })
    .returning({ id: deployments.id })
    .get();
  return row.id;
}

/** Build a name → species.id map for the requested canonical classes. */
async function speciesIdByName(classes: string[]): Promise<Map<string, number>> {
  if (classes.length === 0) return new Map();
  const rows = db
    .select({ id: species.id, name: species.scientificName })
    .from(species)
    .where(inArray(species.scientificName, classes))
    .all();
  return new Map(rows.map((r) => [r.name, r.id]));
}

/**
 * Run the import end to end for an already-claimed processing job. Mirrors the
 * training-export background job: fire-and-forget, progress on `processingJobs`,
 * a completion system-event at the end.
 */
export async function processExternalImportJob(
  jobId: number,
  params: ExternalImportParams,
): Promise<void> {
  try {
    const jobRow = db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .get() as ProcessingJob;
    await recordEvent(buildJobStartEvent(jobRow));

    // Progress helper: surface each phase to the floating progress bar
    // (statusMessage) AND to stdout (docker logs). The candidate-resolution
    // phase below streams hundreds of MB and can take minutes, so without these
    // updates the UI looks frozen.
    const setStatus = (statusMessage: string) => {
      log.info({ jobId }, `[external-import] ${statusMessage}`);
      db.update(processingJobs)
        .set({ statusMessage })
        .where(eq(processingJobs.id, jobId))
        .run();
    };

    // 1. Resolve candidates from each dataset, capped per class. Datasets whose
    //    COCO categories are common names (e.g. Orinoquía) only resolve through
    //    LILA's taxonomy CSV, so fetch it once unless the caller supplied a map.
    const capByClass = resolveCapByClass(params.requestedClasses);
    setStatus("Descargando catálogo de taxonomía LILA…");
    const taxonomyMap = params.taxonomyMap ?? (await fetchLilaTaxonomyMap());
    let candidates: ImportCandidate[] = [];
    for (const dataset of params.datasets) {
      // Streaming metadata parse for a big dataset (WCS ~840MB) takes minutes;
      // onProgress keeps the UI + logs alive throughout.
      const found = await fetchLilaMetadata(dataset, capByClass, taxonomyMap, setStatus);
      candidates.push(...found);
    }

    // 2. Skip anything already imported (idempotent on dataset+sourceImageId).
    const already = new Set(
      db
        .select({
          d: externalImages.sourceDataset,
          s: externalImages.sourceImageId,
        })
        .from(externalImages)
        .all()
        .map((r) => `${r.d}\u0000${r.s}`),
    );
    candidates = candidates.filter(
      (c) => !already.has(`${c.sourceDataset}\u0000${c.sourceImageId}`),
    );

    db.update(processingJobs)
      .set({
        totalImages: candidates.length,
        downloadTotal: candidates.length,
        statusMessage: `Preparando ${candidates.length} imágenes externas…`,
      })
      .where(eq(processingJobs.id, jobId))
      .run();

    if (candidates.length === 0) {
      await finishJob(jobId, { imported: 0, noDetection: 0, failed: 0 });
      return;
    }

    await ensureExternalProject();
    const speciesMap = await speciesIdByName(params.requestedClasses);

    // 3. Create image rows (one per candidate) under synthetic deployments.
    const deploymentBySlug = new Map<string, number>();
    for (const dataset of params.datasets) {
      deploymentBySlug.set(dataset.slug, await ensureExternalDeployment(dataset));
    }

    interface Pending {
      candidate: ImportCandidate;
      imageId: number;
      destPath: string;
    }
    const pending: Pending[] = [];
    for (const c of candidates) {
      const deploymentId = deploymentBySlug.get(c.sourceDataset)!;
      const stem = sanitizeFileStem(c.sourceImageId);
      const destDir = path.join(EXTERNAL_DIR, c.sourceDataset);
      const destPath = path.join(destDir, `${stem}.jpg`);
      const row = db
        .insert(images)
        .values({
          deploymentId,
          jobId,
          filename: `${stem}.jpg`,
          path: destPath,
          isExternal: true,
          status: "pending",
        })
        .returning({ id: images.id })
        .get();
      pending.push({ candidate: c, imageId: row.id, destPath });
    }

    // 4. Download + EXIF-scrub (sharp re-encode drops all metadata).
    const limit = pLimit(DOWNLOAD_CONCURRENCY);
    let downloaded = 0;
    let failed = 0;
    const ok: Pending[] = [];
    await Promise.all(
      pending.map((p) =>
        limit(async () => {
          try {
            await downloadExternalFrame(p.candidate.sourceUrl, p.destPath);
            ok.push(p);
            downloaded += 1;
          } catch (err) {
            failed += 1;
            db.update(images)
              .set({
                status: "failed",
                errorMessage: err instanceof Error ? err.message : "download failed",
              })
              .where(eq(images.id, p.imageId))
              .run();
          }
          if (downloaded % 25 === 0 || downloaded === pending.length) {
            db.update(processingJobs)
              .set({
                downloadedImages: downloaded,
                statusMessage: `Descargando imágenes externas… (${downloaded}/${pending.length})`,
              })
              .where(eq(processingJobs.id, jobId))
              .run();
          }
        }),
      ),
    );

    // 5. Create detections from LILA's PRECOMPUTED MegaDetector boxes (no
    //    detector runs here) and attach our verified mapped-class identification
    //    + provenance. Boxes come from the import candidates (LILA MDv5a-RDE).
    db.update(processingJobs)
      .set({ statusMessage: "Registrando detecciones y etiquetas…" })
      .where(eq(processingJobs.id, jobId))
      .run();

    let imported = 0;
    let noDetection = 0;
    for (const p of ok) {
      const c = p.candidate;
      // Defensive: candidates from fetchLilaMetadata always carry a box; a
      // box-less one means no usable detection, so mark the frame blank.
      if (!c.bbox) {
        noDetection += 1;
        db.update(images)
          .set({ status: "processed", confirmedBlank: true })
          .where(eq(images.id, p.imageId))
          .run();
        continue;
      }

      const [bx, by, bw, bh] = c.bbox;
      const det = db
        .insert(detections)
        .values({
          imageId: p.imageId,
          jobId,
          bboxX: bx,
          bboxY: by,
          bboxWidth: bw,
          bboxHeight: bh,
          detectionConfidence: c.detConf ?? 0,
          detectionClass: 0, // animal
          modelVersion: c.detectorVersion ?? "lila-import",
        })
        .returning({ id: detections.id })
        .get();

      db.insert(identifications)
        .values({
          detectionId: det.id,
          species: c.mappedClass,
          confidence: c.detConf ?? 0,
          modelVersion: "lila-import",
          verificationStatus: "verified",
          verifiedBy: "lila-import",
          verifiedAt: new Date(),
        })
        .run();

      db.insert(externalImages)
        .values({
          imageId: p.imageId,
          sourceDataset: c.sourceDataset,
          sourceImageId: c.sourceImageId,
          sourceUrl: c.sourceUrl,
          originalTaxon: c.originalTaxon,
          license: c.license,
          mappedSpeciesId: speciesMap.get(c.mappedClass) ?? null,
        })
        .run();

      db.update(images)
        .set({ status: "processed" })
        .where(eq(images.id, p.imageId))
        .run();
      imported += 1;
    }

    await finishJob(jobId, { imported, noDetection, failed });
  } catch (err) {
    db.update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "external import failed",
      })
      .where(eq(processingJobs.id, jobId))
      .run();
    const failedRow = db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .get() as ProcessingJob;
    await recordEvent(buildJobCompletionEvent(failedRow));
  }
}

async function finishJob(
  jobId: number,
  extras: { imported: number; noDetection: number; failed: number },
): Promise<void> {
  db.update(processingJobs)
    .set({
      status: "completed",
      completedAt: new Date(),
      processedImages: extras.imported,
      failedImages: extras.failed,
      statusMessage: `Importadas ${extras.imported} imágenes (${extras.noDetection} sin detección, ${extras.failed} fallidas)`,
    })
    .where(eq(processingJobs.id, jobId))
    .run();
  const latest = db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .get() as ProcessingJob;
  await recordEvent(buildJobCompletionEvent(latest, extras));
}
