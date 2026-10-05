/**
 * Server actions for BirdNET threshold validation campaigns.
 *
 * Lifecycle: sampled -> reviewing -> fitted -> applied, with abandoned
 * reachable throughout and `draft` reserved for the one state that is not part
 * of the path — a species whose draw failed when it was added.
 */

"use server";

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  audioDetections,
  audioFiles,
  audioIdentifications,
  birdnetValidationCampaigns,
  birdnetValidationCampaignReviewers,
  birdnetValidationReviews,
  birdnetValidationSamples,
  birdnetSpeciesThresholds,
  species as speciesTable,
  users,
} from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import {
  getUserCameraTrapProjects,
} from "@/lib/camera-trap-auth";
import { recordEvent } from "@/lib/system-events";
import { log } from "@/lib/log";
import {
  fitAndPersistCampaigns,
  resolveModelVersion,
} from "@/lib/birdnet-validation/fit-job";
import { drawSampleCore } from "@/lib/birdnet-validation/sample-core";
import { countByBin } from "@/lib/birdnet-validation/sampling";
import {
  detectedSpeciesCache,
  projectScopeKey,
} from "@/lib/birdnet-validation/ttl-cache";
import { speciesSlug } from "@/lib/species-slug";
import {
  canonicalBirdnetName,
  isNonSpeciesLabel,
  loadBirdnetNames,
  resolveBirdnetName,
} from "@/lib/birdnet-taxonomy";
import {
  clipWindow,
  detectionBand,
  recordingInstant,
} from "@/lib/birdnet-validation/clip-geometry";
import {
  computeAgreement,
  type AgreementResult,
  type ReviewPair,
} from "@/lib/birdnet-validation/agreement";
import {
  resolveFitEligibleReviews,
  summarizeEligible,
} from "@/lib/birdnet-validation/fit-eligibility";
import {
  CAMPAIGN_PRIORITIES,
  DEFAULT_BIN_COUNT,
  DEFAULT_CAMPAIGN_PRIORITY,
  DEFAULT_TARGET_SAMPLE_SIZE,
  FIT_ELIGIBILITY_REASON_ES,
  MIN_REVIEWS_FOR_FIT,
  POST_REVIEW_STATUSES,
  SCORE_FLOOR,
  isPastReview,
  type CampaignPriority,
  type CampaignStatus,
  type FitEligibilityReason,
  type ReviewOutcome,
} from "@/lib/birdnet-validation/types";
import { deriveRestoredStatus } from "./restore-status";
import { loadSpeciesOccupancyStatus } from "@/lib/occupancy/threshold-status";
import type { ActionResult } from "@/lib/types";

const HASH_MODULUS = 2147483647;

/**
 * The reviewer whose answers a campaign's counts read, expressed in SQL for
 * the campaign-index listing. Mirrors `resolveFitReviewer`: the designated
 * primary, else the sole reviewer when there is exactly one, else NULL — which
 * makes every count below come out zero rather than silently summing across
 * reviewers and reporting three times the real review count.
 *
 * Outer columns are written with the literal table name
 * (`birdnet_validation_campaigns.id`), never `${birdnetValidationCampaigns.id}`:
 * Drizzle renders that interpolation as a bare `"id"`, which SQLite resolves
 * against the INNER table and silently yields wrong counts.
 */
const EFFECTIVE_REVIEWER = sql`COALESCE(
  birdnet_validation_campaigns.primary_reviewer_email,
  (SELECT CASE WHEN COUNT(DISTINCT r2.reviewer_email) = 1
               THEN MIN(r2.reviewer_email) END
     FROM birdnet_validation_reviews r2
     JOIN birdnet_validation_samples s2 ON s2.id = r2.sample_id
    WHERE s2.campaign_id = birdnet_validation_campaigns.id)
)`;

function eligibleCount(extra: ReturnType<typeof sql>) {
  return sql`SELECT COUNT(*)
    FROM birdnet_validation_reviews r
    JOIN birdnet_validation_samples s ON s.id = r.sample_id
   WHERE s.campaign_id = birdnet_validation_campaigns.id
     AND r.reviewer_email = ${EFFECTIVE_REVIEWER}
     ${extra}`;
}

export interface CampaignSummary {
  id: number;
  species: string;
  status: CampaignStatus;
  /** Which species to review next; `medium` for everything not singled out. */
  priority: CampaignPriority;
  /**
   * "Requiere experto": the current reviewers cannot judge this species.
   * Orthogonal to priority — a species can be urgent AND need an expert.
   */
  needsExpert: boolean;
  targetSampleSize: number;
  binCount: number;
  abandonedReason: string | null;
  /** Free-text field notes, or null. */
  notes: string | null;
  sampled: number;
  /** Counts over the fit-eligible review set, not summed across reviewers. */
  reviewed: number;
  correct: number;
  incorrect: number;
  uncertain: number;
  createdBy: string;
  /** How many distinct people have recorded at least one review. */
  reviewerCount: number;
  primaryReviewerEmail: string | null;
}

export interface BinProgress {
  binIndex: number;
  drawn: number;
  reviewed: number;
  correct: number;
}

export interface SiteCoverage {
  /** Null when the deployment carries no site name; rendered, never dropped. */
  siteName: string | null;
  drawn: number;
  reviewed: number;
  /**
   * Fit-eligible reviews at this site answered `correct` — the primary
   * reviewer's (or the sole reviewer's) answers, never pooled.
   *
   * NULL — withheld from the payload, not merely unrendered — when the
   * eligible set cannot be resolved (`fitEligibilityReason`), or when the
   * caller is still blind to it (`siteCorrectBlinded`).
   */
  correct: number | null;
}

export interface CampaignProgress extends CampaignSummary {
  bins: BinProgress[];
  /** Per-deployment spread of the drawn sample. */
  sites: SiteCoverage[];
  /** Reviews recorded since the most recent fit, if any. */
  reviewsSinceFit: number | null;
  /**
   * Why the fit-eligible review set could not be resolved, if it could not.
   * Non-null means the scalar counts above are zero because the portal cannot
   * tell whose answers to read — not because nobody has reviewed.
   */
  fitEligibilityReason: FitEligibilityReason | null;
  /**
   * True when `sites[].correct` is withheld from THIS caller for blinding.
   *
   * The review client shows each clip's site, so per-site correct counts made
   * of the primary's answers would let a colleague still reviewing read the
   * primary's judgments off by site ("confirmed at COV-A" + "this clip is from
   * COV-A"). They are released once the caller has answered every clip in the
   * sample, once the species' review is over (`POST_REVIEW_STATUSES`), or to
   * the fit-eligible reviewer, whose own answers they are.
   */
  siteCorrectBlinded: boolean;
}

function errorResult(error: unknown, fallback: string): ActionResult<never> {
  return {
    success: false,
    error: error instanceof Error ? error.message : fallback,
  };
}

/**
 * Is this one of the three levels the column's CHECK constraint accepts?
 *
 * Guards every write path. The alternative is letting SQLite reject it, which
 * surfaces as `SQLITE_CONSTRAINT_CHECK` — accurate, unreadable, and in Spanish
 * nowhere.
 */
function isCampaignPriority(value: unknown): value is CampaignPriority {
  return CAMPAIGN_PRIORITIES.includes(value as CampaignPriority);
}

async function loadCampaign(campaignId: number) {
  const [campaign] = await db
    .select()
    .from(birdnetValidationCampaigns)
    .where(eq(birdnetValidationCampaigns.id, campaignId));
  return campaign ?? null;
}

// ---------------------------------------------------------------------------
// Campaign creation
// ---------------------------------------------------------------------------

/**
 * Add a species to the validation list and draw its sample.
 *
 * The draw is part of creation rather than a stage of its own: a species with
 * no sample cannot be reviewed, so leaving the two apart only ever produced a
 * row someone had to come back and finish.
 *
 * A failed draw is reported but does NOT fail the call. The species is real,
 * it is in the list, and its draw can be re-run from its row ("Preparar") —
 * rolling it back would discard the one thing that definitely succeeded, and
 * the bulk importer relies on exactly this isolation per species.
 */
export async function createCampaign(input: {
  species: string;
  ctProjectId?: number | null;
  targetSampleSize?: number;
  binCount?: number;
  /** Free-text field notes; blank and whitespace-only collapse to null. */
  notes?: string | null;
  /** Review urgency; omitted means the unmarked default. */
  priority?: CampaignPriority;
}): Promise<
  ActionResult<{ campaignId: number; drawn: number; drawError: string | null }>
> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const species = input.species.trim();
    if (!species) {
      return { success: false, error: "Debe indicar una especie" };
    }

    const ctProjectId = input.ctProjectId ?? null;

    // Pre-check for a friendly Spanish message; the partial unique index is the
    // real guard against a concurrent duplicate.
    const existing = await db
      .select({ id: birdnetValidationCampaigns.id })
      .from(birdnetValidationCampaigns)
      .where(
        and(
          eq(birdnetValidationCampaigns.species, species),
          ctProjectId === null
            ? isNull(birdnetValidationCampaigns.ctProjectId)
            : eq(birdnetValidationCampaigns.ctProjectId, ctProjectId),
          sql`${birdnetValidationCampaigns.status} != 'abandoned'`
        )
      );

    if (existing.length > 0) {
      return {
        success: false,
        error: `Ya se está validando ${species}`,
      };
    }

    const [created] = await db
      .insert(birdnetValidationCampaigns)
      .values({
        species,
        ctProjectId,
        notes: input.notes?.trim() || null,
        // Validated rather than passed through, and written explicitly rather
        // than left to the column default: the CHECK constraint would raise
        // SQLITE_CONSTRAINT_CHECK on a bad value, reaching the caller as an
        // opaque failure after every readable pre-check above had passed.
        priority: isCampaignPriority(input.priority)
          ? input.priority
          : DEFAULT_CAMPAIGN_PRIORITY,
        targetSampleSize: input.targetSampleSize ?? DEFAULT_TARGET_SAMPLE_SIZE,
        binCount: input.binCount ?? DEFAULT_BIN_COUNT,
        seed: Math.floor(Math.random() * HASH_MODULUS),
        createdBy: user.email,
      })
      .returning();

    const ctProjects = ctProjectId
      ? [ctProjectId]
      : await getUserCameraTrapProjects(user);

    let drawn = 0;
    let drawError: string | null = null;
    try {
      const result = await drawSampleCore(created, ctProjects);
      drawn = result.inserted;
    } catch (error) {
      drawError =
        error instanceof Error ? error.message : "No se pudo extraer la muestra";
      log.warn(
        { err: error, species },
        "[birdnet-validation] sample draw failed at creation; species kept as draft"
      );
    }

    revalidatePath("/audio/validacion");
    return { success: true, data: { campaignId: created.id, drawn, drawError } };
  } catch (error) {
    if (String(error).includes("UNIQUE constraint")) {
      return {
        success: false,
        error: `Ya se está validando ${input.species}`,
      };
    }
    return errorResult(error, "Error al iniciar la validación");
  }
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Re-run a draw that failed when the species was added.
 *
 * The recovery path, not the normal one — `createCampaign` draws. Reachable
 * from the "Preparar" action a row shows while it has no sample.
 */
export async function drawSample(
  campaignId: number
): Promise<ActionResult<{ inserted: number; available: number[]; allocated: number[] }>> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };

    const ctProjects = campaign.ctProjectId
      ? [campaign.ctProjectId]
      : await getUserCameraTrapProjects(user);

    const result = await drawSampleCore(campaign, ctProjects);

    revalidatePath("/audio/validacion");
    return { success: true, data: result };
  } catch (error) {
    return errorResult(error, "Error al extraer la muestra");
  }
}

/**
 * Replace a species' free-text notes.
 *
 * Notes are a working annotation, not a creation-time fact: "CHECK" becomes
 * "confirmed with JF" once someone has checked, and a species whose note can
 * only be fixed by deleting and re-adding it would cost its whole drawn sample
 * to correct a typo. Editable at any stage, including abandoned — a discarded
 * species is exactly the one whose reason someone comes back to read.
 *
 * Blank clears rather than refusing: removing a note that no longer applies is
 * as legitimate as writing one.
 */
export async function updateCampaignNotes(
  campaignId: number,
  notes: string
): Promise<ActionResult> {
  await requirePermission("grabaciones", "editor");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Especie no encontrada" };

    await db
      .update(birdnetValidationCampaigns)
      .set({ notes: notes.trim() || null })
      .where(eq(birdnetValidationCampaigns.id, campaignId));

    revalidatePath("/audio/validacion");
    revalidatePath(`/audio/validacion/${speciesSlug(campaign.species)}`);
    return { success: true, data: undefined };
  } catch (error) {
    return errorResult(error, "Error al guardar las notas");
  }
}

/**
 * Set which species a reviewer should pick up next.
 *
 * Editable at every stage, including `applied` and `abandoned`: priority is a
 * statement about the queue, not about the species, and a discarded species
 * that gets restored should come back with the urgency it was given rather
 * than reset to the baseline.
 *
 * Deliberately NOT audited through `recordEvent`. It is a scheduling
 * annotation somebody will flip several times in one sitting while triaging a
 * list, which is exactly the high-frequency case the instrumentation
 * convention says to keep out of the event log. Applying a threshold — the
 * action that changes what the portal reports — is audited.
 */
export async function updateCampaignPriority(
  campaignId: number,
  priority: string
): Promise<ActionResult> {
  await requirePermission("grabaciones", "editor");

  try {
    if (!isCampaignPriority(priority)) {
      return { success: false, error: "Prioridad no válida" };
    }

    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Especie no encontrada" };

    await db
      .update(birdnetValidationCampaigns)
      .set({ priority })
      .where(eq(birdnetValidationCampaigns.id, campaignId));

    revalidatePath("/audio/validacion");
    revalidatePath(`/audio/validacion/${speciesSlug(campaign.species)}`);
    return { success: true, data: undefined };
  } catch (error) {
    return errorResult(error, "Error al guardar la prioridad");
  }
}

/**
 * Tag or untag a species as needing an expert ("Requiere experto").
 *
 * Independent of priority: priority says which species to review next, this
 * says the current reviewers cannot judge it. Mirrors `updateCampaignPriority`
 * in every other respect — editor, editable at any stage, and deliberately NOT
 * audited, because it gets flipped repeatedly in one triage sitting.
 */
export async function updateCampaignNeedsExpert(
  campaignId: number,
  needsExpert: boolean
): Promise<ActionResult> {
  await requirePermission("grabaciones", "editor");

  try {
    if (typeof needsExpert !== "boolean") {
      return { success: false, error: "Valor no válido" };
    }

    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Especie no encontrada" };

    await db
      .update(birdnetValidationCampaigns)
      .set({ needsExpert })
      .where(eq(birdnetValidationCampaigns.id, campaignId));

    revalidatePath("/audio/validacion");
    revalidatePath(`/audio/validacion/${speciesSlug(campaign.species)}`);
    return { success: true, data: undefined };
  } catch (error) {
    return errorResult(error, "Error al guardar la etiqueta de experto");
  }
}

export async function abandonCampaign(
  campaignId: number,
  reason: string
): Promise<ActionResult> {
  await requirePermission("grabaciones", "editor");

  try {
    const trimmed = reason.trim();
    if (!trimmed) {
      return { success: false, error: "Debe indicar un motivo" };
    }

    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };

    await db
      .update(birdnetValidationCampaigns)
      .set({ status: "abandoned", abandonedReason: trimmed })
      .where(eq(birdnetValidationCampaigns.id, campaignId));

    revalidatePath("/audio/validacion");
    return { success: true, data: undefined };
  } catch (error) {
    return errorResult(error, "Error al descartar la validación");
  }
}

/**
 * Remove a species from the list entirely.
 *
 * Distinct from `abandonCampaign`, which records a decision to stop. This is
 * for a row that should never have existed — a name added before the species
 * picker existed, a typo, a wrong project scope — and it takes the campaign's
 * samples and roster with it through the FK cascade.
 *
 * REFUSED once anything has been reviewed or fitted. The cascade would take a
 * colleague's afternoon of listening with it, silently and with no undo, and
 * "I meant to remove the empty one" is not distinguishable at the SQL layer
 * from "I removed the wrong row". The review count is deliberately taken across
 * ALL reviewers rather than the caller's own: destroying your own work is a
 * choice, destroying someone else's is an accident waiting to happen.
 */
export async function deleteCampaign(
  campaignId: number
): Promise<ActionResult<{ species: string }>> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };

    const [reviewRow] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(birdnetValidationReviews)
      .innerJoin(
        birdnetValidationSamples,
        eq(birdnetValidationSamples.id, birdnetValidationReviews.sampleId)
      )
      .where(eq(birdnetValidationSamples.campaignId, campaignId));
    const reviewCount = Number(reviewRow?.n ?? 0);

    if (reviewCount > 0) {
      return {
        success: false,
        error: `No se puede eliminar: ya hay ${reviewCount} revisiones de esta especie. Usa "Descartar" para dejar de validarla sin perder el trabajo.`,
      };
    }

    const [fitRow] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(birdnetSpeciesThresholds)
      .where(eq(birdnetSpeciesThresholds.campaignId, campaignId));

    if (Number(fitRow?.n ?? 0) > 0) {
      return {
        success: false,
        error:
          'No se puede eliminar: esta especie tiene ajustes de umbral. Usa "Descartar".',
      };
    }

    const [sampleRow] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(birdnetValidationSamples)
      .where(eq(birdnetValidationSamples.campaignId, campaignId));
    const sampleCount = Number(sampleRow?.n ?? 0);

    // Samples, roster and (vacuously) thresholds go with it via ON DELETE
    // CASCADE — see the FKs in src/db/schema.ts.
    await db
      .delete(birdnetValidationCampaigns)
      .where(eq(birdnetValidationCampaigns.id, campaignId));

    await recordEvent({
      eventType: "birdnet_validation_deleted",
      source: "audio",
      severity: "warn",
      actorEmail: user.email,
      projectId: "grabaciones",
      targetType: "species",
      targetId: campaign.species,
      summary: `Validación eliminada para ${campaign.species}`,
      details: {
        campaignId,
        previousStatus: campaign.status,
        samplesDeleted: sampleCount,
      },
    });

    revalidatePath("/audio/validacion");
    return { success: true, data: { species: campaign.species } };
  } catch (error) {
    return errorResult(error, "Error al eliminar la validación");
  }
}

/**
 * Undo a discard, returning the species to the stage it had reached.
 *
 * The stage is derived rather than stored — see `deriveRestoredStatus`.
 *
 * The partial unique index on (species, scope) excludes abandoned rows, so a
 * live campaign may have been started for this species since the discard. That
 * surfaces as a UNIQUE constraint, which is translated here rather than leaking
 * a SQLite error string into the UI.
 */
export async function restoreCampaign(
  campaignId: number
): Promise<ActionResult<{ status: CampaignStatus }>> {
  await requirePermission("grabaciones", "editor");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };
    if (campaign.status !== "abandoned") {
      return { success: false, error: "Esta validación no está descartada" };
    }

    const [sampleRow] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(birdnetValidationSamples)
      .where(eq(birdnetValidationSamples.campaignId, campaignId));

    const [reviewRow] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(birdnetValidationReviews)
      .innerJoin(
        birdnetValidationSamples,
        eq(birdnetValidationSamples.id, birdnetValidationReviews.sampleId)
      )
      .where(eq(birdnetValidationSamples.campaignId, campaignId));

    const fits = await db
      .select({
        isActive: birdnetSpeciesThresholds.isActive,
        unusableReason: birdnetSpeciesThresholds.unusableReason,
      })
      .from(birdnetSpeciesThresholds)
      .where(eq(birdnetSpeciesThresholds.campaignId, campaignId))
      .orderBy(desc(birdnetSpeciesThresholds.fittedAt));

    const status = deriveRestoredStatus({
      hasActiveThreshold: fits.some((f) => f.isActive),
      fitCount: fits.length,
      latestFitUnusable: fits[0]?.unusableReason != null,
      reviewCount: Number(reviewRow?.n ?? 0),
      sampledAt: campaign.sampledAt,
      sampleCount: Number(sampleRow?.n ?? 0),
    });

    try {
      await db
        .update(birdnetValidationCampaigns)
        .set({ status, abandonedReason: null })
        .where(eq(birdnetValidationCampaigns.id, campaignId));
    } catch (error) {
      if (String(error).includes("UNIQUE constraint")) {
        return {
          success: false,
          error: `Ya se está validando ${campaign.species} de nuevo. Elimina o descarta esa validación antes de recuperar ésta.`,
        };
      }
      throw error;
    }

    revalidatePath("/audio/validacion");
    return { success: true, data: { status } };
  } catch (error) {
    return errorResult(error, "Error al recuperar la validación");
  }
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * Record one review outcome, scoped to the calling reviewer.
 *
 * Writes into `birdnet_validation_reviews` keyed (sample, caller). The unique
 * index there is what prevents one reviewer from displacing another's answer,
 * so there is deliberately no defensive "is this row someone else's?" check —
 * the constraint is the guard, and a hand-written check would be a second,
 * weaker copy of it that could drift.
 *
 * Idempotent on (sample, caller, outcome): the queue advances optimistically
 * and a held key or retried request must not move the timestamp. Recording a
 * different outcome revises the caller's own answer, so stepping back to
 * correct yourself works.
 */
export async function recordReview(
  sampleId: number,
  outcome: ReviewOutcome,
  notes?: string
): Promise<ActionResult> {
  /*
    VIEWER, deliberately, and this is the one write in the module that a viewer
    can perform.

    Listening is the scarce resource and the people who have it — students,
    visiting taxonomists — are exactly the people who should not hold `editor`
    on `grabaciones`, which also carries `deleteAudioDetection`,
    `bulkUpdateAudioMetadata` and `cancelBirdNETJob`. Gating review on editor
    made "can judge a clip" and "can delete the corpus" the same grant.

    What this write can actually do is bounded: it inserts or updates ONE row
    in `birdnet_validation_reviews`, which is `UNIQUE(sample_id,
    reviewer_email)` — a reviewer can only ever overwrite their own answer,
    never a colleague's — enrols the caller in the roster, and advances the
    species from `sampled` to `reviewing`. It deletes nothing and touches no
    recording, detection or identification.

    Nor does a viewer's answer reach production on its own: `setPrimaryReviewer`,
    `runFit`, `applyThreshold` and `markSpeciesNoFilter` all stay editor, so an
    editor still decides whose reviews the fit reads and whether the resulting
    threshold is applied.
  */
  const user = await requirePermission("grabaciones", "viewer");

  try {
    const [sample] = await db
      .select({
        id: birdnetValidationSamples.id,
        campaignId: birdnetValidationSamples.campaignId,
      })
      .from(birdnetValidationSamples)
      .where(eq(birdnetValidationSamples.id, sampleId));

    if (!sample) return { success: false, error: "Detección no encontrada" };

    const campaign = await loadCampaign(sample.campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };
    if (campaign.status === "abandoned") {
      return { success: false, error: "Esta validación fue descartada" };
    }

    const [existing] = await db
      .select({
        id: birdnetValidationReviews.id,
        outcome: birdnetValidationReviews.outcome,
      })
      .from(birdnetValidationReviews)
      .where(
        and(
          eq(birdnetValidationReviews.sampleId, sampleId),
          eq(birdnetValidationReviews.reviewerEmail, user.email)
        )
      );

    // Same answer again: leave the original timestamp so a double keystroke is
    // a true no-op rather than a silent edit.
    if (existing && existing.outcome === outcome && !notes) {
      return { success: true, data: undefined };
    }

    if (existing) {
      await db
        .update(birdnetValidationReviews)
        .set({
          outcome,
          notes: notes ?? null,
          reviewedAt: new Date(),
          // A correction names what the clip was INSTEAD of this species, so it
          // only means anything on an `incorrect` answer. Leaving `incorrect`
          // clears it; re-affirming `incorrect` keeps it (the column is simply
          // not in the SET).
          ...(outcome === "incorrect" ? {} : { correctedSpecies: null }),
        })
        .where(eq(birdnetValidationReviews.id, existing.id));
    } else {
      await db.insert(birdnetValidationReviews).values({
        sampleId,
        reviewerEmail: user.email,
        outcome,
        notes: notes ?? null,
        reviewedAt: new Date(),
      });
    }

    // Reviewing enrolls you. The roster is a denominator for progress, not an
    // access gate, so it must never be able to block a review that permission
    // already allows.
    await ensureRostered(campaign.id, user.email, user.email);

    if (campaign.status === "sampled") {
      await db
        .update(birdnetValidationCampaigns)
        .set({ status: "reviewing" })
        .where(eq(birdnetValidationCampaigns.id, campaign.id));
    }

    return { success: true, data: undefined };
  } catch (error) {
    return errorResult(error, "Error al registrar la revisión");
  }
}

// ---------------------------------------------------------------------------
// Reviewer corrections ("what the clip really was")
// ---------------------------------------------------------------------------

/**
 * Attach, change or clear the species a clip REALLY was, on the caller's own
 * `incorrect` review.
 *
 * A separate write from `recordReview` on purpose: the answer is saved the
 * instant "No" is pressed, and the species arrives later as an optional second
 * write. It lands on the caller's own review row only — never on
 * `audio_identifications.corrected_species` — so it changes no count, chart,
 * export, occupancy input or fit. Suggestions are read elsewhere and never pass
 * through `resolveFitEligibleReviews`.
 *
 * The submitted name is re-resolved here against BirdNET's label list; the
 * client picker is a convenience, not the guard.
 *
 * Viewer, like `recordReview`, and equally bounded: one column of one row the
 * caller already owns. Not audited — a per-clip write, like the review itself.
 */
export async function setReviewCorrection(
  sampleId: number,
  species: string | null
): Promise<ActionResult<{ correctedSpecies: string | null }>> {
  const user = await requirePermission("grabaciones", "viewer");

  try {
    if (!Number.isInteger(sampleId)) {
      return { success: false, error: "Detección no válida" };
    }

    const [sample] = await db
      .select({
        id: birdnetValidationSamples.id,
        campaignId: birdnetValidationSamples.campaignId,
      })
      .from(birdnetValidationSamples)
      .where(eq(birdnetValidationSamples.id, sampleId));
    if (!sample) return { success: false, error: "Detección no encontrada" };

    const campaign = await loadCampaign(sample.campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };
    if (campaign.status === "abandoned") {
      return { success: false, error: "Esta validación fue descartada" };
    }

    const [review] = await db
      .select({
        id: birdnetValidationReviews.id,
        outcome: birdnetValidationReviews.outcome,
      })
      .from(birdnetValidationReviews)
      .where(
        and(
          eq(birdnetValidationReviews.sampleId, sampleId),
          eq(birdnetValidationReviews.reviewerEmail, user.email)
        )
      );
    if (!review) {
      return {
        success: false,
        error: "Primero responde esta detección antes de indicar la especie",
      };
    }
    if (review.outcome !== "incorrect") {
      return {
        success: false,
        error:
          "Solo se puede indicar la especie real en una detección marcada como incorrecta",
      };
    }

    let correctedSpecies: string | null = null;
    if (species !== null) {
      if (typeof species !== "string" || !species.trim()) {
        return { success: false, error: "Indica una especie" };
      }
      const canonical = canonicalBirdnetName(species);
      if (!canonical) {
        return {
          success: false,
          error: `"${species.trim()}" no está en la lista de especies de BirdNET`,
        };
      }
      if (isNonSpeciesLabel(canonical)) {
        return {
          success: false,
          error: `"${canonical}" no es una especie`,
        };
      }
      if (canonical === campaign.species) {
        return {
          success: false,
          error:
            "La especie real no puede ser la misma que se está validando; si lo era, marca la detección como correcta",
        };
      }
      correctedSpecies = canonical;
    }

    // reviewed_at deliberately untouched: naming the species is not a new
    // judgment of the clip, and "reviews since fit" must not count it as one.
    await db
      .update(birdnetValidationReviews)
      .set({ correctedSpecies })
      .where(eq(birdnetValidationReviews.id, review.id));

    return { success: true, data: { correctedSpecies } };
  } catch (error) {
    return errorResult(error, "Error al guardar la especie real");
  }
}

/**
 * One option in the correction picker, as a positional tuple to keep ~6.5k
 * rows lean on a phone: `[scientificName, englishName, spanishName | null]`.
 */
export type CorrectionSpeciesOption = [
  scientificName: string,
  commonName: string,
  spanishName: string | null,
];

export interface CorrectionSpeciesList {
  /**
   * Labels detected at least once in the caller's accessible projects, most
   * detected first. Ranked ahead because the clip's real species is far more
   * likely one this portal has heard before.
   */
  detected: CorrectionSpeciesOption[];
  /** Every other BirdNET species label, alphabetical by scientific name. */
  others: CorrectionSpeciesOption[];
}

/**
 * The vocabulary for the "what was it really?" picker: BirdNET's own species
 * labels (the same list `setReviewCorrection` validates against), minus the
 * non-species classes (Dog, Engine, Noise, ...). Fetched once per review
 * session, not per clip, and the detected-species ranking behind it is cached
 * per project scope for `DETECTED_SPECIES_TTL_MS`.
 *
 * Detected-first uses the same project scope as `listValidatableSpecies`. A
 * detected label that is not in BirdNET's list is left out: the write would
 * refuse it.
 */
export async function listCorrectionSpecies(): Promise<
  ActionResult<CorrectionSpeciesList>
> {
  const user = await requirePermission("grabaciones", "viewer");

  try {
    const ctProjects = await getUserCameraTrapProjects(user);
    // Cached per project scope: the GROUP BY spans every identification, and
    // the result only ranks a picker list, so minutes-stale is harmless.
    const counts = detectedSpeciesCache.get(projectScopeKey(ctProjects), () =>
      detectedSpeciesCounts(ctProjects)
    );
    const names = loadBirdnetNames();

    const detectedCount = new Map<string, number>();
    for (const row of counts) {
      if (names.has(row.species)) detectedCount.set(row.species, Number(row.n));
    }

    const detected: Array<[CorrectionSpeciesOption, number]> = [];
    const others: CorrectionSpeciesOption[] = [];
    for (const [scientificName, n] of names) {
      if (isNonSpeciesLabel(scientificName)) continue;
      const option: CorrectionSpeciesOption = [
        scientificName,
        n.commonName,
        n.spanishName,
      ];
      const count = detectedCount.get(scientificName);
      if (count !== undefined) detected.push([option, count]);
      else others.push(option);
    }

    detected.sort((a, b) => b[1] - a[1] || a[0][0].localeCompare(b[0][0]));
    others.sort((a, b) => a[0].localeCompare(b[0]));

    return {
      success: true,
      data: { detected: detected.map(([option]) => option), others },
    };
  } catch (error) {
    return errorResult(error, "Error al cargar la lista de especies");
  }
}

// ---------------------------------------------------------------------------
// Reviewer suggestions ("clips attributed to this species")
// ---------------------------------------------------------------------------

/**
 * The caller's camera-trap project scope as a SQL predicate over the `d`
 * (biochoco_deployments) alias — the same scope `detectedSpeciesCounts` and
 * the sampler apply.
 *
 * Over a LEFT JOIN it also decides recordings with no deployment: `'all'`
 * (`1 = 1`) keeps them, while a project list never matches a NULL
 * `d.ct_project_id`, so a scoped caller does not see them.
 */
function deploymentScopeSql(
  ctProjects: Awaited<ReturnType<typeof getUserCameraTrapProjects>>
) {
  if (ctProjects === "all") return sql`1 = 1`;
  if (ctProjects.length === 0) return sql`1 = 0`;
  return sql`d.ct_project_id IN (${sql.join(
    ctProjects.map((id) => sql`${id}`),
    sql`, `
  )})`;
}

/**
 * Common names for a scientific name: the species table first (curated), then
 * BirdNET's own label list, which covers a corrected species with no
 * `biochoco_species` row.
 */
async function speciesNamesFor(
  scientificNames: string[]
): Promise<Map<string, { commonName: string | null; spanishName: string | null }>> {
  const out = new Map<string, { commonName: string | null; spanishName: string | null }>();
  if (scientificNames.length === 0) return out;
  const rows = await db
    .select({
      scientificName: speciesTable.scientificName,
      commonName: speciesTable.commonName,
      spanishName: speciesTable.spanishName,
    })
    .from(speciesTable)
    .where(inArray(speciesTable.scientificName, scientificNames));
  for (const row of rows) {
    out.set(row.scientificName, {
      commonName: row.commonName,
      spanishName: row.spanishName,
    });
  }
  for (const name of scientificNames) {
    if (out.has(name)) continue;
    const birdnet = resolveBirdnetName(name);
    out.set(name, {
      commonName: birdnet?.commonName ?? null,
      spanishName: birdnet?.spanishName ?? null,
    });
  }
  return out;
}

/** One reviewer's attribution of another species' clip to this one. */
export interface SpeciesSuggestion {
  /** The review row; unique per (sample, reviewer), so a stable row key. */
  reviewId: number;
  sampleId: number;
  /** The species whose sample the clip was drawn for (and judged incorrect). */
  sourceSpecies: string;
  sourceCommonName: string | null;
  sourceSpanishName: string | null;
  siteName: string | null;
  /** Wall-clock recording time of the detection, or null. */
  recordedAt: string | null;
  reviewerEmail: string;
  reviewerName: string | null;
  /** ISO timestamp of the review. */
  reviewedAt: string;
}

/** What the species page may show of the suggestions for one species. */
export interface SpeciesSuggestions {
  /** Rows the caller may see — see `getSpeciesSuggestions` for the rule. */
  suggestions: SpeciesSuggestion[];
  /**
   * Suggestions withheld from the caller because they would reveal a
   * colleague's `incorrect` answer on a clip the caller still has to judge.
   * A bare count: no clip, site, time or reviewer travels with it.
   */
  hidden: number;
}

/**
 * Clips reviewers marked `incorrect` for another species and attributed to
 * `species` — one row per (sample, reviewer), so two reviewers naming the same
 * clip show twice, each labelled.
 *
 * Deliberately a separate read: these clips are NOT part of `species`' sample.
 * Nothing here passes through `resolveFitEligibleReviews`, and no fit, bin or
 * site coverage, or total reads it — mixing them in would break the
 * score-bin stratification the fit depends on.
 *
 * BLINDING. A suggestion is a colleague's `incorrect` answer with the clip's
 * site, recording time and reviewer attached — the review client shows the same
 * site and time, so a rostered reviewer who read this list first would know a
 * colleague's answer before judging the clip. A row is therefore returned only
 * when the caller:
 *   - has their own review of that sample (their judgment is already made), or
 *   - IS the suggesting reviewer, or
 *   - the SOURCE species' review is over (`POST_REVIEW_STATUSES`).
 * Withheld rows are counted, never returned — filtering in the page would still
 * put them in the RSC payload.
 *
 * Viewer, like every other read in the module, and scoped to the caller's
 * accessible projects the way `listValidatableSpecies` is. A recording with no
 * deployment is visible only to an unscoped (`'all'`) caller, which is exactly
 * what `deploymentScopeSql` over a LEFT JOIN yields.
 */
export async function getSpeciesSuggestions(
  species: string
): Promise<ActionResult<SpeciesSuggestions>> {
  const user = await requirePermission("grabaciones", "viewer");

  try {
    const target = typeof species === "string" ? species.trim() : "";
    if (!target) return { success: true, data: { suggestions: [], hidden: 0 } };

    const ctProjects = await getUserCameraTrapProjects(user);
    // `r.outcome = 'incorrect'` is belt-and-braces: `recordReview` clears the
    // correction whenever the answer leaves incorrect.
    //
    // The visibility test runs in SQL and hidden rows are reduced to a count
    // here, so their details never leave this function.
    const rows = db.all<{
      reviewId: number;
      sampleId: number;
      sourceSpecies: string;
      siteName: string | null;
      filename: string | null;
      detectionStart: number;
      reviewerEmail: string;
      reviewedAt: number;
      visible: number;
    }>(sql`
      SELECT r.id AS reviewId,
             s.id AS sampleId,
             c.species AS sourceSpecies,
             s.site_name AS siteName,
             af.filename AS filename,
             ad.start_time AS detectionStart,
             r.reviewer_email AS reviewerEmail,
             r.reviewed_at AS reviewedAt,
             CASE WHEN r.reviewer_email = ${user.email}
                    OR c.status IN (${sql.join(
                      POST_REVIEW_STATUSES.map((st) => sql`${st}`),
                      sql`, `
                    )})
                    OR EXISTS (
                      SELECT 1 FROM birdnet_validation_reviews mine
                       WHERE mine.sample_id = r.sample_id
                         AND mine.reviewer_email = ${user.email}
                    )
                  THEN 1 ELSE 0 END AS visible
      FROM birdnet_validation_reviews r
      JOIN birdnet_validation_samples s ON s.id = r.sample_id
      JOIN birdnet_validation_campaigns c ON c.id = s.campaign_id
      JOIN audio_identifications ai ON ai.id = s.audio_identification_id
      JOIN audio_detections ad ON ad.id = ai.audio_detection_id
      JOIN audio_files af ON af.id = ad.audio_file_id
      LEFT JOIN biochoco_deployments d ON d.id = af.deployment_id
      WHERE r.corrected_species = ${target}
        AND r.outcome = 'incorrect'
        AND ${deploymentScopeSql(ctProjects)}
      ORDER BY r.reviewed_at DESC, r.id DESC
    `);

    const visibleRows = rows.filter((r) => Number(r.visible) === 1);
    const hidden = rows.length - visibleRows.length;

    const names = await speciesNamesFor([
      ...new Set(visibleRows.map((r) => r.sourceSpecies)),
    ]);
    const reviewerEmails = [...new Set(visibleRows.map((r) => r.reviewerEmail))];
    const userRows = reviewerEmails.length
      ? await db
          .select({ email: users.email, name: users.name })
          .from(users)
          .where(inArray(users.email, reviewerEmails))
      : [];
    const nameByEmail = new Map(userRows.map((u) => [u.email, u.name]));

    const suggestions: SpeciesSuggestion[] = visibleRows.map((row) => {
      const n = names.get(row.sourceSpecies);
      return {
        reviewId: row.reviewId,
        sampleId: row.sampleId,
        sourceSpecies: row.sourceSpecies,
        sourceCommonName: n?.commonName ?? null,
        sourceSpanishName: n?.spanishName ?? null,
        siteName: row.siteName,
        recordedAt: recordingInstant(row.filename, row.detectionStart),
        reviewerEmail: row.reviewerEmail,
        reviewerName: nameByEmail.get(row.reviewerEmail) ?? null,
        // Drizzle's `timestamp` mode stores Unix SECONDS; this is a raw read.
        reviewedAt: new Date(Number(row.reviewedAt) * 1000).toISOString(),
      };
    });

    return { success: true, data: { suggestions, hidden } };
  } catch (error) {
    return errorResult(error, "Error al cargar las sugerencias de los revisores");
  }
}

/**
 * How many detections a draw for `species` could find in the caller's scope —
 * the same filter `drawSampleCore` applies (BirdNET's raw prediction, the
 * [0.1, 1.0] score range, the caller's projects).
 *
 * The suggestions-only page reads this before offering "Añadir especie": a
 * reviewer can name any BirdNET label, and adding one with nothing to draw
 * would leave a permanent `draft` row.
 */
export async function countDrawableDetections(
  species: string
): Promise<ActionResult<number>> {
  const user = await requirePermission("grabaciones", "viewer");
  try {
    const target = typeof species === "string" ? species.trim() : "";
    if (!target) return { success: true, data: 0 };
    const ctProjects = await getUserCameraTrapProjects(user);
    const perBin = await countByBin(target, ctProjects, DEFAULT_BIN_COUNT);
    return { success: true, data: perBin.reduce((a, b) => a + b, 0) };
  } catch (error) {
    return errorResult(error, "Error al contar las detecciones");
  }
}

/** Suggestion totals for one attributed species, for the species table. */
export interface SuggestionCount {
  species: string;
  commonName: string | null;
  spanishName: string | null;
  /** (sample, reviewer) rows — what the species page lists. */
  suggestions: number;
  /** Distinct clips among them. */
  clips: number;
}

/**
 * How many reviewer suggestions each species has, scoped like
 * `getSpeciesSuggestions`. Includes species with no validation at all — that
 * is how they become discoverable.
 *
 * Aggregate counts only, so they are NOT blinded: a number per attributed
 * species names no clip, site or reviewer. The species page may therefore list
 * fewer rows than this counts, and says how many it is withholding.
 */
export async function listSuggestionCounts(): Promise<ActionResult<SuggestionCount[]>> {
  const user = await requirePermission("grabaciones", "viewer");

  try {
    const ctProjects = await getUserCameraTrapProjects(user);
    const rows = db.all<{ species: string; suggestions: number; clips: number }>(sql`
      SELECT r.corrected_species AS species,
             COUNT(*) AS suggestions,
             COUNT(DISTINCT r.sample_id) AS clips
      FROM birdnet_validation_reviews r
      JOIN birdnet_validation_samples s ON s.id = r.sample_id
      JOIN audio_identifications ai ON ai.id = s.audio_identification_id
      JOIN audio_detections ad ON ad.id = ai.audio_detection_id
      JOIN audio_files af ON af.id = ad.audio_file_id
      LEFT JOIN biochoco_deployments d ON d.id = af.deployment_id
      WHERE r.corrected_species IS NOT NULL
        AND r.outcome = 'incorrect'
        AND ${deploymentScopeSql(ctProjects)}
      GROUP BY r.corrected_species
    `);

    const names = await speciesNamesFor(rows.map((r) => r.species));
    const data: SuggestionCount[] = rows
      .map((row) => ({
        species: row.species,
        commonName: names.get(row.species)?.commonName ?? null,
        spanishName: names.get(row.species)?.spanishName ?? null,
        suggestions: Number(row.suggestions),
        clips: Number(row.clips),
      }))
      .sort((a, b) => b.suggestions - a.suggestions || a.species.localeCompare(b.species));

    return { success: true, data };
  } catch (error) {
    return errorResult(error, "Error al contar las sugerencias de los revisores");
  }
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/** Idempotent enrolment; safe to call on every review. */
async function ensureRostered(
  campaignId: number,
  reviewerEmail: string,
  addedBy: string
): Promise<void> {
  const [existing] = await db
    .select({ id: birdnetValidationCampaignReviewers.id })
    .from(birdnetValidationCampaignReviewers)
    .where(
      and(
        eq(birdnetValidationCampaignReviewers.campaignId, campaignId),
        eq(birdnetValidationCampaignReviewers.reviewerEmail, reviewerEmail)
      )
    );
  if (existing) return;

  await db
    .insert(birdnetValidationCampaignReviewers)
    .values({ campaignId, reviewerEmail, addedBy });
}

/*
 * There is no `addReviewer`. Enrolling someone by email had a form on the
 * species page and was removed on 2026-08-10: it read as an invitation while
 * sending no mail and granting no access (reviewing is gated on the portal's
 * editor permission for Grabaciones, never on this roster), so all it produced
 * was a 0/200 row ahead of time. `ensureRostered` still runs from `recordReview`
 * and from `setPrimaryReviewer`, which are the two moments membership means
 * something.
 */

/**
 * Unenroll a reviewer. Their recorded reviews are left intact — the roster is
 * a denominator, and deleting recorded judgments to tidy a list would destroy
 * data that the agreement statistics and the fit both read.
 */
export async function removeReviewer(
  campaignId: number,
  reviewerEmail: string
): Promise<ActionResult> {
  await requirePermission("grabaciones", "editor");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };

    if (campaign.primaryReviewerEmail === reviewerEmail) {
      return {
        success: false,
        error:
          "No se puede quitar al revisor principal. Designe otro revisor principal primero.",
      };
    }

    await db
      .delete(birdnetValidationCampaignReviewers)
      .where(
        and(
          eq(birdnetValidationCampaignReviewers.campaignId, campaignId),
          eq(birdnetValidationCampaignReviewers.reviewerEmail, reviewerEmail)
        )
      );

    revalidatePath(`/audio/validacion/${campaignId}`);
    return { success: true, data: undefined };
  } catch (error) {
    return errorResult(error, "Error al quitar el revisor");
  }
}

/**
 * Designate whose answers the fit consumes.
 *
 * Audited because it silently changes what a subsequent fit will read: the
 * same campaign, refitted after this call, can produce a different threshold
 * without any review having changed.
 */
export async function setPrimaryReviewer(
  campaignId: number,
  reviewerEmail: string | null
): Promise<ActionResult> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };

    const email = reviewerEmail?.trim().toLowerCase() || null;
    if (email) await ensureRostered(campaignId, email, user.email);

    await db
      .update(birdnetValidationCampaigns)
      .set({ primaryReviewerEmail: email })
      .where(eq(birdnetValidationCampaigns.id, campaignId));

    await recordEvent({
      source: "audio",
      eventType: "birdnet_validation.primary_reviewer_changed",
      severity: "info",
      summary: email
        ? `Revisor principal de ${campaign.species}: ${email}`
        : `Revisor principal de ${campaign.species} sin designar`,
      actorEmail: user.email,
      projectId: "grabaciones",
      targetType: "birdnet_validation_campaign",
      targetId: campaignId,
      details: {
        species: campaign.species,
        previous: campaign.primaryReviewerEmail,
        next: email,
      },
    });

    revalidatePath(`/audio/validacion/${campaignId}`);
    return { success: true, data: undefined };
  } catch (error) {
    return errorResult(error, "Error al designar el revisor principal");
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export async function getCampaignProgress(
  campaignId: number
): Promise<ActionResult<CampaignProgress>> {
  const user = await requirePermission("grabaciones", "viewer");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };

    // Drawn counts are per-sample; reviewed counts come from the fit-eligible
    // set so the coverage chart shows what the model will actually consume,
    // not the sum across every reviewer.
    const drawnByBin = await db
      .select({
        binIndex: birdnetValidationSamples.binIndex,
        drawn: sql<number>`COUNT(*)`,
      })
      .from(birdnetValidationSamples)
      .where(eq(birdnetValidationSamples.campaignId, campaignId))
      .groupBy(birdnetValidationSamples.binIndex)
      .orderBy(asc(birdnetValidationSamples.binIndex));

    const [sampledRow] = await db
      .select({ sampled: sql<number>`COUNT(*)` })
      .from(birdnetValidationSamples)
      .where(eq(birdnetValidationSamples.campaignId, campaignId));

    const eligible = await resolveFitEligibleReviews(campaignId);
    const eligibleReviews = eligible.ok ? eligible.reviews : [];
    const totals = summarizeEligible(eligibleReviews);

    const [reviewerCountRow] = await db
      .select({
        n: sql<number>`COUNT(DISTINCT ${birdnetValidationReviews.reviewerEmail})`,
      })
      .from(birdnetValidationReviews)
      .innerJoin(
        birdnetValidationSamples,
        eq(birdnetValidationSamples.id, birdnetValidationReviews.sampleId)
      )
      .where(eq(birdnetValidationSamples.campaignId, campaignId));

    const perBin = new Map<number, { reviewed: number; correct: number }>();
    for (const review of eligibleReviews) {
      const entry = perBin.get(review.binIndex) ?? { reviewed: 0, correct: 0 };
      entry.reviewed += 1;
      if (review.outcome === "correct") entry.correct += 1;
      perBin.set(review.binIndex, entry);
    }

    const [latestFit] = await db
      .select({ nReviewed: birdnetSpeciesThresholds.nReviewed })
      .from(birdnetSpeciesThresholds)
      .where(eq(birdnetSpeciesThresholds.campaignId, campaignId))
      .orderBy(desc(birdnetSpeciesThresholds.fittedAt))
      .limit(1);

    // Grouped in JS from rows already fetched below rather than a second
    // GROUP BY: the sample is at most a few hundred rows, and a per-site query
    // would be a third round trip for a panel that is pure reporting.
    const sampleRows = await db
      .select({
        id: birdnetValidationSamples.id,
        siteName: birdnetValidationSamples.siteName,
      })
      .from(birdnetValidationSamples)
      .where(eq(birdnetValidationSamples.campaignId, campaignId));

    // Site correctness reads the same fit-eligible set as everything else, so
    // the per-site `correct` counts sum to the fit's correct total. When the
    // set cannot be resolved the counts are withheld — never a pooled count
    // across reviewers.
    const outcomeBySample = new Map(
      eligibleReviews.map((r) => [r.sampleId, r.outcome])
    );

    // Blinding (see `CampaignProgress.siteCorrectBlinded`).
    const callerIsFitReviewer = eligible.ok && eligible.reviewerEmail === user.email;
    let siteCorrectBlinded = false;
    if (!callerIsFitReviewer && !isPastReview(campaign.status)) {
      const [ownRow] = db.all<{ n: number }>(sql`
        SELECT COUNT(*) AS n
          FROM birdnet_validation_samples s
         WHERE s.campaign_id = ${campaignId}
           AND NOT EXISTS (
             SELECT 1 FROM birdnet_validation_reviews r
              WHERE r.sample_id = s.id AND r.reviewer_email = ${user.email}
           )
      `);
      siteCorrectBlinded = Number(ownRow?.n ?? 0) > 0;
    }
    const releaseSiteCorrect = eligible.ok && !siteCorrectBlinded;
    const bySite = new Map<
      string | null,
      { drawn: number; reviewed: number; correct: number }
    >();
    for (const row of sampleRows) {
      const entry = bySite.get(row.siteName) ?? { drawn: 0, reviewed: 0, correct: 0 };
      entry.drawn += 1;
      const outcome = outcomeBySample.get(row.id);
      if (outcome) entry.reviewed += 1;
      if (outcome === "correct") entry.correct += 1;
      bySite.set(row.siteName, entry);
    }
    const sites: SiteCoverage[] = [...bySite.entries()]
      .map(([siteName, counts]) => ({
        siteName,
        drawn: counts.drawn,
        reviewed: counts.reviewed,
        correct: releaseSiteCorrect ? counts.correct : null,
      }))
      .sort((a, b) => b.drawn - a.drawn || (a.siteName ?? "").localeCompare(b.siteName ?? ""));

    const reviewed = totals.reviewed;
    const uncertain = totals.uncertain;

    return {
      success: true,
      data: {
        id: campaign.id,
        species: campaign.species,
        status: campaign.status as CampaignStatus,
        priority: campaign.priority as CampaignPriority,
        needsExpert: campaign.needsExpert,
        targetSampleSize: campaign.targetSampleSize,
        binCount: campaign.binCount,
        abandonedReason: campaign.abandonedReason,
        notes: campaign.notes,
        createdBy: campaign.createdBy,
        primaryReviewerEmail: campaign.primaryReviewerEmail,
        reviewerCount: Number(reviewerCountRow?.n ?? 0),
        fitEligibilityReason: eligible.ok ? null : eligible.reason,
        siteCorrectBlinded,
        sampled: Number(sampledRow?.sampled ?? 0),
        reviewed,
        correct: totals.correct,
        incorrect: totals.incorrect,
        uncertain,
        bins: drawnByBin.map((b) => ({
          binIndex: b.binIndex,
          drawn: Number(b.drawn),
          reviewed: perBin.get(b.binIndex)?.reviewed ?? 0,
          correct: perBin.get(b.binIndex)?.correct ?? 0,
        })),
        sites,
        // Usable reviews (excluding uncertain) beyond what the last fit saw.
        reviewsSinceFit: latestFit
          ? Math.max(0, reviewed - uncertain - latestFit.nReviewed)
          : null,
      },
    };
  } catch (error) {
    return errorResult(error, "Error al cargar el progreso");
  }
}

export async function listCampaigns(): Promise<ActionResult<CampaignSummary[]>> {
  await requirePermission("grabaciones", "viewer");

  try {
    const rows = await db
      .select({
        id: birdnetValidationCampaigns.id,
        species: birdnetValidationCampaigns.species,
        status: birdnetValidationCampaigns.status,
        priority: birdnetValidationCampaigns.priority,
        needsExpert: birdnetValidationCampaigns.needsExpert,
        targetSampleSize: birdnetValidationCampaigns.targetSampleSize,
        binCount: birdnetValidationCampaigns.binCount,
        abandonedReason: birdnetValidationCampaigns.abandonedReason,
        notes: birdnetValidationCampaigns.notes,
        createdBy: birdnetValidationCampaigns.createdBy,
        primaryReviewerEmail: birdnetValidationCampaigns.primaryReviewerEmail,
        sampled: sql<number>`(
          SELECT COUNT(*) FROM birdnet_validation_samples s
          WHERE s.campaign_id = birdnet_validation_campaigns.id
        )`,
        reviewerCount: sql<number>`(
          SELECT COUNT(DISTINCT r.reviewer_email)
          FROM birdnet_validation_reviews r
          JOIN birdnet_validation_samples s ON s.id = r.sample_id
          WHERE s.campaign_id = birdnet_validation_campaigns.id
        )`,
        reviewed: sql<number>`(${eligibleCount(sql``)})`,
        correct: sql<number>`(${eligibleCount(sql`AND r.outcome = 'correct'`)})`,
        incorrect: sql<number>`(${eligibleCount(sql`AND r.outcome = 'incorrect'`)})`,
        uncertain: sql<number>`(${eligibleCount(sql`AND r.outcome = 'uncertain'`)})`,
      })
      .from(birdnetValidationCampaigns)
      .orderBy(asc(birdnetValidationCampaigns.species));

    return {
      success: true,
      data: rows.map((r) => ({
        ...r,
        status: r.status as CampaignStatus,
        priority: r.priority as CampaignPriority,
        sampled: Number(r.sampled),
        reviewerCount: Number(r.reviewerCount),
        reviewed: Number(r.reviewed),
        correct: Number(r.correct),
        incorrect: Number(r.incorrect),
        uncertain: Number(r.uncertain),
      })),
    };
  } catch (error) {
    return errorResult(error, "Error al listar las especies");
  }
}

/** One selectable species, as the picker and the bulk import both see it. */
export interface ValidatableSpecies {
  scientificName: string;
  /** English common name; null when the species has no lookup-table row. */
  commonName: string | null;
  spanishName: string | null;
  /** BirdNET detections visible to the caller. Never null; zero is possible. */
  detectionCount: number;
  /** Status of the active validation for this species, or null when there is none. */
  activeStatus: CampaignStatus | null;
}

/**
 * BirdNET detection counts per label, scoped to the caller's accessible
 * camera-trap projects. Shared by the validatable-species picker and the
 * correction picker so both rank from the same scope.
 */
function detectedSpeciesCounts(
  ctProjects: Awaited<ReturnType<typeof getUserCameraTrapProjects>>
): Array<{ species: string; n: number }> {
  // Raw SQL for the join to deployments: the project scope is expressed over
  // the `d` alias, matching the sampling module's `projectScope`.
  //
  // `+ai.species` (unary plus) keeps the planner OFF idx_audio_id_species. With
  // the index it walks every row in species order to skip the GROUP BY sort,
  // then fetches each row's detection/file/deployment at random — 1.3 s → 4.9 s
  // on the dev DB. A sequential scan plus a temp b-tree is the faster plan here.
  return db.all<{ species: string; n: number }>(sql`
    SELECT ai.species AS species, COUNT(*) AS n
    FROM audio_identifications ai
    JOIN audio_detections ad ON ad.id = ai.audio_detection_id
    JOIN audio_files af ON af.id = ad.audio_file_id
    JOIN biochoco_deployments d ON d.id = af.deployment_id
    WHERE ai.species IS NOT NULL
      AND ${deploymentScopeSql(ctProjects)}
    GROUP BY +ai.species
  `);
}

/**
 * Every species BirdNET has actually detected, with what it takes to decide
 * whether to validate it.
 *
 * Sourced from `audio_identifications` and left-joined to the species table,
 * NOT the other way round. The species table carries the full ~6k BirdNET
 * taxonomy; only ~554 labels have ever been detected in this portal, and
 * offering all 6k is the same "type a name and hope" problem in a longer list.
 * One detected label has no species row at all, so the join must tolerate a
 * miss rather than dropping the row.
 *
 * Counts are scoped to the caller's accessible camera-trap projects so the
 * number shown at selection time matches what a draw would actually find — a
 * species whose only detections sit in an inaccessible project reports zero
 * rather than a number the caller cannot act on.
 */
export async function listValidatableSpecies(): Promise<
  ActionResult<ValidatableSpecies[]>
> {
  const user = await requirePermission("grabaciones", "viewer");

  try {
    const ctProjects = await getUserCameraTrapProjects(user);
    const counts = detectedSpeciesCounts(ctProjects);

    const speciesRows = await db
      .select({
        scientificName: speciesTable.scientificName,
        commonName: speciesTable.commonName,
        spanishName: speciesTable.spanishName,
      })
      .from(speciesTable);
    const nameByScientific = new Map(speciesRows.map((s) => [s.scientificName, s]));

    // Abandoned validations do not block starting a new one, matching the
    // duplicate pre-check in `createCampaign`.
    const active = await db
      .select({
        species: birdnetValidationCampaigns.species,
        status: birdnetValidationCampaigns.status,
      })
      .from(birdnetValidationCampaigns)
      .where(sql`${birdnetValidationCampaigns.status} != 'abandoned'`);
    const statusBySpecies = new Map(active.map((c) => [c.species, c.status]));

    const data: ValidatableSpecies[] = counts.map((row) => {
      const names = nameByScientific.get(row.species);
      return {
        scientificName: row.species,
        commonName: names?.commonName ?? null,
        spanishName: names?.spanishName ?? null,
        detectionCount: Number(row.n),
        activeStatus: (statusBySpecies.get(row.species) as CampaignStatus) ?? null,
      };
    });

    data.sort((a, b) => a.scientificName.localeCompare(b.scientificName));
    return { success: true, data };
  } catch (error) {
    return errorResult(error, "Error al listar las especies disponibles");
  }
}

/**
 * The caller's own next unreviewed samples, in queue order.
 *
 * Every reviewer walks the identical `order_index` sequence — full overlap
 * means the sample is not partitioned — and only their personal answers are
 * filtered out of it. The returned rows carry no `reviewOutcome` field at all:
 * under full overlap a sample has several outcomes, and shipping any of them
 * to the review client would let one reviewer see another's judgment, which is
 * exactly what the blinding exists to prevent.
 */
export async function getReviewQueue(
  campaignId: number,
  limit = 25
): Promise<
  ActionResult<
    Array<{
      sampleId: number;
      audioIdentificationId: number;
      confidence: number;
      binIndex: number;
      siteName: string | null;
      habitat: string | null;
      orderIndex: number;
      /**
       * Left edge of the detection within the clip, as a percentage.
       *
       * An ESTIMATE, computed from the window we asked ffmpeg for. The client
       * replaces it with `measuredBand` as soon as the audio element reports a
       * duration, because a window running past the end of the recording comes
       * back short and these percentages then point at the wrong audio. Sent
       * anyway so the band renders on the first frame rather than appearing a
       * beat later.
       */
      bandLeftPct: number;
      /** Right edge, likewise — same estimate, same replacement. */
      bandRightPct: number;
      /** Estimated clip length in seconds, before AAC encoder padding. */
      clipSpanSeconds: number;
      /** Offset of the clip's first sample into the recording, in seconds. */
      clipStartSeconds: number;
      /** The BirdNET window's bounds within the recording, in seconds. */
      detectionStartSeconds: number;
      detectionEndSeconds: number;
      /** Wall-clock recording time, or null when the filename carries none. */
      recordedAt: string | null;
      /**
       * The source recording's own filename (e.g. `…_090000.flac`), named after
       * the recording START — the displayed `recordedAt` adds the detection
       * offset, so without this a reviewer searching Drive finds nothing.
       * Carries no score.
       */
      filename: string;
    }>
  >
> {
  // Viewer, matching `recordReview` — a reviewer who may answer must be able
  // to load the clips they are answering about.
  const user = await requirePermission("grabaciones", "viewer");

  try {
    const rows = await db
      .select({
        sampleId: birdnetValidationSamples.id,
        audioIdentificationId: birdnetValidationSamples.audioIdentificationId,
        confidence: birdnetValidationSamples.confidence,
        binIndex: birdnetValidationSamples.binIndex,
        siteName: birdnetValidationSamples.siteName,
        habitat: birdnetValidationSamples.habitat,
        orderIndex: birdnetValidationSamples.orderIndex,
        // Same join chain as `loadClipSource`: the sample points at an
        // IDENTIFICATION, so going straight to `audio_detections` would join on
        // an unrelated id space. Bounds come from the detection, which is
        // stable, not from the sample's snapshot.
        detectionStart: audioDetections.startTime,
        detectionEnd: audioDetections.endTime,
        fileDuration: audioFiles.duration,
        filename: audioFiles.filename,
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
      .where(
        and(
          eq(birdnetValidationSamples.campaignId, campaignId),
          sql`NOT EXISTS (
            SELECT 1 FROM birdnet_validation_reviews r
            WHERE r.sample_id = birdnet_validation_samples.id
              AND r.reviewer_email = ${user.email}
          )`
        )
      )
      .orderBy(asc(birdnetValidationSamples.orderIndex))
      .limit(limit);

    // The clamp rule lives with the audio cut that shares it, so the window is
    // computed here. The BAND it implies is only a first guess: the client
    // re-derives it from the decoded clip, which is the only thing that knows
    // how much audio ffmpeg actually returned.
    const data = rows.map((row) => {
      const win = clipWindow({
        startTime: row.detectionStart,
        endTime: row.detectionEnd,
        duration: row.fileDuration,
      });
      const band = detectionBand(win, {
        startTime: row.detectionStart,
        endTime: row.detectionEnd,
      });
      return {
        sampleId: row.sampleId,
        audioIdentificationId: row.audioIdentificationId,
        confidence: row.confidence,
        binIndex: row.binIndex,
        siteName: row.siteName,
        habitat: row.habitat,
        orderIndex: row.orderIndex,
        bandLeftPct: band.leftPct,
        bandRightPct: band.rightPct,
        clipSpanSeconds: win.end - win.start,
        // Absolute seconds, so the client can recompute the band against the
        // clip it actually received. See `measuredBand`.
        clipStartSeconds: win.start,
        detectionStartSeconds: row.detectionStart,
        detectionEndSeconds: row.detectionEnd,
        recordedAt: recordingInstant(row.filename, row.detectionStart),
        filename: row.filename,
      };
    });

    return { success: true, data };
  } catch (error) {
    return errorResult(error, "Error al cargar la cola de revisión");
  }
}

/**
 * The campaign roster with each reviewer's own completion counts.
 *
 * Rostered-but-idle reviewers appear with zeros — that is the whole reason the
 * roster exists as a table rather than being derived from recorded reviews.
 */
export interface ReviewerProgress {
  email: string;
  name: string | null;
  reviewed: number;
  correct: number;
  incorrect: number;
  uncertain: number;
  isPrimary: boolean;
}

export async function getReviewerProgress(
  campaignId: number
): Promise<ActionResult<ReviewerProgress[]>> {
  await requirePermission("grabaciones", "viewer");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };

    const rostered = await db
      .select({ email: birdnetValidationCampaignReviewers.reviewerEmail })
      .from(birdnetValidationCampaignReviewers)
      .where(eq(birdnetValidationCampaignReviewers.campaignId, campaignId));

    const counts = await db
      .select({
        email: birdnetValidationReviews.reviewerEmail,
        reviewed: sql<number>`COUNT(*)`,
        correct: sql<number>`SUM(CASE WHEN ${birdnetValidationReviews.outcome} = 'correct' THEN 1 ELSE 0 END)`,
        incorrect: sql<number>`SUM(CASE WHEN ${birdnetValidationReviews.outcome} = 'incorrect' THEN 1 ELSE 0 END)`,
        uncertain: sql<number>`SUM(CASE WHEN ${birdnetValidationReviews.outcome} = 'uncertain' THEN 1 ELSE 0 END)`,
      })
      .from(birdnetValidationReviews)
      .innerJoin(
        birdnetValidationSamples,
        eq(birdnetValidationSamples.id, birdnetValidationReviews.sampleId)
      )
      .where(eq(birdnetValidationSamples.campaignId, campaignId))
      .groupBy(birdnetValidationReviews.reviewerEmail);

    const countMap = new Map(counts.map((c) => [c.email, c]));
    // Union of rostered and has-reviewed: a reviewer removed from the roster
    // keeps their reviews, so their counts must still be reachable.
    const emails = new Set<string>([
      ...rostered.map((r) => r.email),
      ...counts.map((c) => c.email),
    ]);
    if (campaign.primaryReviewerEmail) emails.add(campaign.primaryReviewerEmail);

    const nameRows = emails.size
      ? await db.select({ email: users.email, name: users.name }).from(users)
      : [];
    const nameMap = new Map(nameRows.map((u) => [u.email, u.name]));

    const progress: ReviewerProgress[] = [...emails].map((email) => {
      const c = countMap.get(email);
      return {
        email,
        name: nameMap.get(email) ?? null,
        reviewed: Number(c?.reviewed ?? 0),
        correct: Number(c?.correct ?? 0),
        incorrect: Number(c?.incorrect ?? 0),
        uncertain: Number(c?.uncertain ?? 0),
        isPrimary: email === campaign.primaryReviewerEmail,
      };
    });

    // Primary first, then most-reviewed, then alphabetical for stability.
    progress.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      if (a.reviewed !== b.reviewed) return b.reviewed - a.reviewed;
      return a.email.localeCompare(b.email);
    });

    return { success: true, data: progress };
  } catch (error) {
    return errorResult(error, "Error al cargar el progreso de los revisores");
  }
}

export interface ReviewerAgreement extends AgreementResult {
  email: string;
  name: string | null;
}

/**
 * Each non-primary reviewer's agreement with the primary.
 *
 * Primary-versus-each rather than all-pairs: the primary is the reference the
 * threshold actually rests on, so that is the comparison that says whether a
 * trainee could be trusted to replace them. Returns an empty list when no
 * primary is designated — there is no reference to measure against, and the
 * page says so rather than silently picking one.
 */
export async function getAgreement(
  campaignId: number
): Promise<ActionResult<ReviewerAgreement[]>> {
  await requirePermission("grabaciones", "viewer");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };
    if (!campaign.primaryReviewerEmail) return { success: true, data: [] };

    const rows = await db
      .select({
        sampleId: birdnetValidationReviews.sampleId,
        reviewerEmail: birdnetValidationReviews.reviewerEmail,
        outcome: birdnetValidationReviews.outcome,
      })
      .from(birdnetValidationReviews)
      .innerJoin(
        birdnetValidationSamples,
        eq(birdnetValidationSamples.id, birdnetValidationReviews.sampleId)
      )
      .where(eq(birdnetValidationSamples.campaignId, campaignId));

    const primaryBySample = new Map<number, ReviewOutcome>();
    for (const row of rows) {
      if (row.reviewerEmail === campaign.primaryReviewerEmail) {
        primaryBySample.set(row.sampleId, row.outcome as ReviewOutcome);
      }
    }

    const byReviewer = new Map<string, ReviewPair[]>();
    for (const row of rows) {
      if (row.reviewerEmail === campaign.primaryReviewerEmail) continue;
      const primary = primaryBySample.get(row.sampleId);
      // Only co-reviewed clips contribute; a clip the primary has not reached
      // yet is not a disagreement.
      if (!primary) continue;
      const list = byReviewer.get(row.reviewerEmail) ?? [];
      list.push({
        sampleId: row.sampleId,
        primary,
        other: row.outcome as ReviewOutcome,
      });
      byReviewer.set(row.reviewerEmail, list);
    }

    const nameRows = await db
      .select({ email: users.email, name: users.name })
      .from(users);
    const nameMap = new Map(nameRows.map((u) => [u.email, u.name]));

    const data = [...byReviewer.entries()]
      .map(([email, pairs]) => ({
        email,
        name: nameMap.get(email) ?? null,
        ...computeAgreement(pairs),
      }))
      .sort((a, b) => b.n - a.n || a.email.localeCompare(b.email));

    return { success: true, data };
  } catch (error) {
    return errorResult(error, "Error al calcular la concordancia");
  }
}

/** One clip where reviewers did not all give the same answer. */
export interface Disagreement {
  sampleId: number;
  audioIdentificationId: number;
  confidence: number;
  binIndex: number;
  siteName: string | null;
  habitat: string | null;
  answers: Array<{ email: string; name: string | null; outcome: ReviewOutcome }>;
}

export async function getDisagreements(
  campaignId: number
): Promise<ActionResult<Disagreement[]>> {
  await requirePermission("grabaciones", "viewer");

  try {
    const rows = await db
      .select({
        sampleId: birdnetValidationSamples.id,
        audioIdentificationId: birdnetValidationSamples.audioIdentificationId,
        confidence: birdnetValidationSamples.confidence,
        binIndex: birdnetValidationSamples.binIndex,
        siteName: birdnetValidationSamples.siteName,
        habitat: birdnetValidationSamples.habitat,
        reviewerEmail: birdnetValidationReviews.reviewerEmail,
        outcome: birdnetValidationReviews.outcome,
      })
      .from(birdnetValidationSamples)
      .innerJoin(
        birdnetValidationReviews,
        eq(birdnetValidationReviews.sampleId, birdnetValidationSamples.id)
      )
      .where(eq(birdnetValidationSamples.campaignId, campaignId));

    const nameRows = await db
      .select({ email: users.email, name: users.name })
      .from(users);
    const nameMap = new Map(nameRows.map((u) => [u.email, u.name]));

    const bySample = new Map<number, Disagreement>();
    for (const row of rows) {
      const entry = bySample.get(row.sampleId) ?? {
        sampleId: row.sampleId,
        audioIdentificationId: row.audioIdentificationId,
        confidence: row.confidence,
        binIndex: row.binIndex,
        siteName: row.siteName,
        habitat: row.habitat,
        answers: [],
      };
      entry.answers.push({
        email: row.reviewerEmail,
        name: nameMap.get(row.reviewerEmail) ?? null,
        outcome: row.outcome as ReviewOutcome,
      });
      bySample.set(row.sampleId, entry);
    }

    const data = [...bySample.values()]
      .filter((s) => new Set(s.answers.map((a) => a.outcome)).size > 1)
      // High-confidence disagreements are the most diagnostic: those are the
      // clips a threshold would retain.
      .sort((a, b) => b.confidence - a.confidence || a.sampleId - b.sampleId)
      .map((s) => ({
        ...s,
        answers: s.answers.sort((x, y) => x.email.localeCompare(y.email)),
      }));

    return { success: true, data };
  } catch (error) {
    return errorResult(error, "Error al cargar los desacuerdos");
  }
}

// ---------------------------------------------------------------------------
// Fitting and application
// ---------------------------------------------------------------------------

/**
 * Fit the logistic model for one campaign and persist the result.
 *
 * Synchronous rather than queued: a two-parameter logistic on ~200 rows costs
 * milliseconds once R is warm, and the ~1.3s interpreter startup is short
 * enough for a button with a pending state. The `birdnet_threshold_fit` job
 * type covers the batch path that refits every campaign.
 */
export async function runFit(
  campaignId: number
): Promise<ActionResult<{ usable: boolean; thresholdConf95: number | null; reason: string | null }>> {
  await requirePermission("grabaciones", "editor");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };
    if (campaign.status === "abandoned") {
      return { success: false, error: "Esta validación fue descartada" };
    }

    // Refuse before R sees anything when the portal cannot tell whose answers
    // to read. Pooling here would look like a successful fit.
    const eligible = await resolveFitEligibleReviews(campaignId);
    if (!eligible.ok) {
      return {
        success: false,
        error: FIT_ELIGIBILITY_REASON_ES[eligible.reason],
      };
    }

    const [persisted] = await fitAndPersistCampaigns([campaignId]);
    if (!persisted) {
      return { success: false, error: "No se pudo ajustar el modelo" };
    }

    revalidatePath("/audio/validacion");
    revalidatePath(`/audio/validacion/${encodeURIComponent(campaign.species)}`);
    return {
      success: true,
      data: {
        usable: persisted.usable,
        thresholdConf95: persisted.thresholdConf95,
        reason: persisted.reason,
      },
    };
  } catch (error) {
    return errorResult(error, "Error al ajustar el modelo");
  }
}

/**
 * Apply a fitted threshold portal-wide.
 *
 * Deliberately separate from fitting: applying rewrites every species count,
 * chart, export, and occupancy input for this species, so it is an explicit,
 * reversible, audited act rather than a side effect of running the model.
 */
export async function applyThreshold(
  thresholdId: number
): Promise<ActionResult<{ species: string; threshold: number }>> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const [row] = await db
      .select()
      .from(birdnetSpeciesThresholds)
      .where(eq(birdnetSpeciesThresholds.id, thresholdId));

    if (!row) return { success: false, error: "Ajuste no encontrado" };
    if (row.thresholdConf95 == null) {
      return {
        success: false,
        error: row.unusableReason ?? "Este ajuste no produjo un umbral utilizable",
      };
    }

    // Deactivate the previous active threshold for this species first — the
    // partial unique index permits only one.
    db.transaction((tx) => {
      tx.update(birdnetSpeciesThresholds)
        .set({ isActive: false })
        .where(
          and(
            eq(birdnetSpeciesThresholds.species, row.species),
            eq(birdnetSpeciesThresholds.isActive, true)
          )
        )
        .run();
      tx.update(birdnetSpeciesThresholds)
        .set({ isActive: true, appliedAt: new Date(), appliedBy: user.email })
        .where(eq(birdnetSpeciesThresholds.id, thresholdId))
        .run();
      tx.update(birdnetValidationCampaigns)
        .set({ status: "applied" })
        .where(eq(birdnetValidationCampaigns.id, row.campaignId))
        .run();
    });

    await recordEvent({
      eventType: "birdnet_threshold_applied",
      source: "audio",
      severity: "info",
      actorEmail: user.email,
      projectId: "grabaciones",
      targetType: "species",
      targetId: row.species,
      summary: `Umbral de BirdNET aplicado para ${row.species}: ${row.thresholdConf95.toFixed(3)}`,
      details: {
        thresholdId,
        thresholdConf95: row.thresholdConf95,
        nReviewed: row.nReviewed,
        nCorrect: row.nCorrect,
        modelVersion: row.modelVersion,
      },
    });

    revalidatePath("/audio");
    revalidatePath("/audio/validacion");
    return {
      success: true,
      data: { species: row.species, threshold: row.thresholdConf95 },
    };
  } catch (error) {
    return errorResult(error, "Error al aplicar el umbral");
  }
}

/**
 * Record that a species needs no confidence filter, and apply it.
 *
 * WHY THIS EXISTS. When every review comes back correct the fit refuses —
 * complete separation, no coefficients, no threshold. That reads as "nothing to
 * do", and it is the opposite. With no applied threshold the species falls back
 * to the GLOBAL 0.70, which for `Ortalis erythroptera` on the dev database
 * discards 13,854 of 24,913 detections whose own review says they are correct.
 * The evidence says keep everything; until now the portal had no way to say it.
 *
 * Mechanically this writes a threshold at the score floor. Every detection
 * BirdNET emits sits at or above 0.1 (verified: min confidence is exactly 0.1,
 * zero rows below), so the floor keeps all of them while still travelling
 * through the ordinary `applySpeciesConfidenceFilter` path — no second
 * mechanism, no special case in nine consumers.
 *
 * It is NOT a fit and never claims to be: `source = "no_filter"`, no intercept,
 * no slope, no CI, and its own event type. Applying is folded in because there
 * is no estimate to inspect first — the two-step flow exists so a fitted number
 * can be read before it takes effect.
 *
 * REFUSES unless every fit-eligible review is correct. On a species BirdNET
 * never gets right this would be the exact wrong move, so the guard is
 * server-side rather than a hidden button.
 */
export async function markSpeciesNoFilter(
  campaignId: number
): Promise<ActionResult<{ species: string; thresholdId: number }>> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return { success: false, error: "Validación no encontrada" };
    if (campaign.status === "abandoned") {
      return { success: false, error: "Esta validación fue descartada" };
    }

    // Same single-reviewer resolution the fit uses. Pooling reviewers here would
    // misstate n exactly as it would in a fit.
    const eligible = await resolveFitEligibleReviews(campaignId);
    if (!eligible.ok) {
      return { success: false, error: FIT_ELIGIBILITY_REASON_ES[eligible.reason] };
    }

    const usable = eligible.reviews.filter(
      (r) => r.outcome === "correct" || r.outcome === "incorrect"
    );
    const nCorrect = usable.filter((r) => r.outcome === "correct").length;

    if (usable.length < MIN_REVIEWS_FOR_FIT) {
      return {
        success: false,
        error: `Se necesitan al menos ${MIN_REVIEWS_FOR_FIT} revisiones utilizables para concluir que no hace falta filtro.`,
      };
    }
    if (nCorrect !== usable.length) {
      return {
        success: false,
        error:
          "Sólo se puede marcar «sin filtro» cuando todas las revisiones son correctas. Aquí hay revisiones incorrectas, así que corresponde ajustar un umbral.",
      };
    }

    const [created] = await db
      .insert(birdnetSpeciesThresholds)
      .values({
        campaignId,
        species: campaign.species,
        nReviewed: usable.length,
        nCorrect,
        nUncertain: eligible.reviews.length - usable.length,
        // Deliberately null: there is no model. Only the 95% slot carries the
        // floor, because that is the one `loadActiveSpeciesThresholds` reads.
        thresholdConf95: SCORE_FLOOR,
        source: "no_filter",
        // Recorded for the same reason a fit records it: "no filter needed" is
        // a conclusion about the scores a particular BirdNET produced, and a
        // reprocess with a different model invalidates it just as it would a
        // fitted threshold.
        modelVersion: await resolveModelVersion(campaignId),
        primaryReviewerEmail: campaign.primaryReviewerEmail,
      })
      .returning();

    if (!created) {
      return { success: false, error: "No se pudo registrar la decisión" };
    }

    db.transaction((tx) => {
      // Only one active row per species — the partial unique index enforces it.
      tx.update(birdnetSpeciesThresholds)
        .set({ isActive: false })
        .where(
          and(
            eq(birdnetSpeciesThresholds.species, campaign.species),
            eq(birdnetSpeciesThresholds.isActive, true)
          )
        )
        .run();
      tx.update(birdnetSpeciesThresholds)
        .set({ isActive: true, appliedAt: new Date(), appliedBy: user.email })
        .where(eq(birdnetSpeciesThresholds.id, created.id))
        .run();
      tx.update(birdnetValidationCampaigns)
        .set({ status: "applied" })
        .where(eq(birdnetValidationCampaigns.id, campaignId))
        .run();
    });

    await recordEvent({
      eventType: "birdnet_no_filter_applied",
      source: "audio",
      severity: "info",
      actorEmail: user.email,
      projectId: "grabaciones",
      targetType: "species",
      targetId: campaign.species,
      summary: `${campaign.species} marcada sin filtro de confianza: ${nCorrect} de ${usable.length} revisiones correctas`,
      details: {
        thresholdId: created.id,
        thresholdConf95: SCORE_FLOOR,
        nReviewed: usable.length,
        nCorrect,
      },
    });

    revalidatePath("/audio");
    revalidatePath("/audio/validacion");
    return {
      success: true,
      data: { species: campaign.species, thresholdId: created.id },
    };
  } catch (error) {
    return errorResult(error, "Error al marcar la especie sin filtro");
  }
}

/** Revert to the global default for this species. */
export async function revertThreshold(
  thresholdId: number
): Promise<ActionResult<{ species: string }>> {
  const user = await requirePermission("grabaciones", "editor");

  try {
    const [row] = await db
      .select()
      .from(birdnetSpeciesThresholds)
      .where(eq(birdnetSpeciesThresholds.id, thresholdId));

    if (!row) return { success: false, error: "Ajuste no encontrado" };
    if (!row.isActive) {
      return { success: false, error: "Este umbral no está aplicado" };
    }

    db.transaction((tx) => {
      tx.update(birdnetSpeciesThresholds)
        .set({ isActive: false, appliedAt: null, appliedBy: null })
        .where(eq(birdnetSpeciesThresholds.id, thresholdId))
        .run();
      // Back to what the campaign was before this row was applied. A
      // `no_filter` row was never a fit, so "fitted" would invent a fit that
      // does not exist — the underlying attempt is what produced no threshold.
      tx.update(birdnetValidationCampaigns)
        .set({ status: row.source === "no_filter" ? "unusable" : "fitted" })
        .where(eq(birdnetValidationCampaigns.id, row.campaignId))
        .run();
    });

    await recordEvent({
      eventType: "birdnet_threshold_reverted",
      source: "audio",
      severity: "warn",
      actorEmail: user.email,
      projectId: "grabaciones",
      targetType: "species",
      targetId: row.species,
      summary: `Umbral de BirdNET revertido para ${row.species}; vuelve al umbral global`,
      details: { thresholdId, previousThreshold: row.thresholdConf95 },
    });

    revalidatePath("/audio");
    revalidatePath("/audio/validacion");
    return { success: true, data: { species: row.species } };
  } catch (error) {
    return errorResult(error, "Error al revertir el umbral");
  }
}

/** Every fit recorded for a campaign, newest first. */
export async function listFits(campaignId: number) {
  await requirePermission("grabaciones", "viewer");
  return db
    .select()
    .from(birdnetSpeciesThresholds)
    .where(eq(birdnetSpeciesThresholds.campaignId, campaignId))
    .orderBy(desc(birdnetSpeciesThresholds.fittedAt));
}

/** What the occupancy models currently say about this species' filter. */
export interface SpeciesOccupancyThresholdView {
  species: string;
  runId: number;
  /** ISO — serialized here because this crosses into a Client Component. */
  runCompletedAt: string | null;
  hasAudioModel: boolean;
  /** Threshold the run filtered this species with; null = the global one. */
  atRun: number | null;
  /** Threshold applied now; null = none, so the global one governs. */
  now: number | null;
  /** 'fit' or 'no_filter' — a decision must never read back as a model's output. */
  nowSource: string | null;
  globalThreshold: number;
  stale: boolean;
  runInProgress: boolean;
}

/**
 * Whether the occupancy models already reflect this species' applied threshold.
 *
 * Lives on the audio side (and is gated on `grabaciones`) because that is where
 * the decision is made: applying a threshold here silently leaves every fitted
 * occupancy model behind, and the person applying it is the one who needs to
 * know. Returns null when no run has ever completed — nothing to be stale.
 */
export async function getSpeciesOccupancyThresholdStatus(
  species: string
): Promise<ActionResult<SpeciesOccupancyThresholdView | null>> {
  await requirePermission("grabaciones", "viewer");
  try {
    const status = await loadSpeciesOccupancyStatus(species);
    if (!status) return { success: true, data: null };
    return {
      success: true,
      data: {
        species,
        runId: status.runId,
        runCompletedAt: status.runCompletedAt?.toISOString() ?? null,
        hasAudioModel: status.hasAudioModel,
        atRun: status.atRun,
        now: status.now,
        nowSource: status.nowSource,
        globalThreshold: status.globalThreshold,
        stale: status.stale,
        runInProgress: status.runInProgress,
      },
    };
  } catch (error) {
    return errorResult(error, "Error al consultar los modelos de ocupación");
  }
}

