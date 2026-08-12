/**
 * Server actions for BirdNET threshold validation campaigns.
 *
 * Lifecycle: sampled -> reviewing -> fitted -> applied, with abandoned
 * reachable throughout and `draft` reserved for the one state that is not part
 * of the path — a species whose draw failed when it was added.
 */

"use server";

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

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
import { speciesSlug } from "@/lib/species-slug";
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
  SCORE_FLOOR,
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
  const user = await requirePermission("grabaciones", "editor");

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
        .set({ outcome, notes: notes ?? null, reviewedAt: new Date() })
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
  await requirePermission("grabaciones", "viewer");

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

    const reviewedSampleIds = new Set(eligibleReviews.map((r) => r.sampleId));
    const bySite = new Map<string | null, { drawn: number; reviewed: number }>();
    for (const row of sampleRows) {
      const entry = bySite.get(row.siteName) ?? { drawn: 0, reviewed: 0 };
      entry.drawn += 1;
      if (reviewedSampleIds.has(row.id)) entry.reviewed += 1;
      bySite.set(row.siteName, entry);
    }
    const sites: SiteCoverage[] = [...bySite.entries()]
      .map(([siteName, counts]) => ({ siteName, ...counts }))
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
        targetSampleSize: campaign.targetSampleSize,
        binCount: campaign.binCount,
        abandonedReason: campaign.abandonedReason,
        notes: campaign.notes,
        createdBy: campaign.createdBy,
        primaryReviewerEmail: campaign.primaryReviewerEmail,
        reviewerCount: Number(reviewerCountRow?.n ?? 0),
        fitEligibilityReason: eligible.ok ? null : eligible.reason,
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

    // Raw SQL for the join to deployments: the project scope is expressed over
    // the `d` alias, matching the sampling module's `projectScope`.
    const counts = db.all<{ species: string; n: number }>(sql`
      SELECT ai.species AS species, COUNT(*) AS n
      FROM audio_identifications ai
      JOIN audio_detections ad ON ad.id = ai.audio_detection_id
      JOIN audio_files af ON af.id = ad.audio_file_id
      JOIN biochoco_deployments d ON d.id = af.deployment_id
      WHERE ai.species IS NOT NULL
        AND ${
          ctProjects === "all"
            ? sql`1 = 1`
            : ctProjects.length === 0
              ? sql`1 = 0`
              : sql`d.ct_project_id IN (${sql.join(
                  ctProjects.map((id) => sql`${id}`),
                  sql`, `
                )})`
        }
      GROUP BY ai.species
    `);

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
      /** Left edge of the detection within the clip, as a percentage. */
      bandLeftPct: number;
      /** Right edge, likewise. */
      bandRightPct: number;
      /** Clip length in seconds, before AAC encoder padding. */
      clipSpanSeconds: number;
      /** Wall-clock recording time, or null when the filename carries none. */
      recordedAt: string | null;
    }>
  >
> {
  const user = await requirePermission("grabaciones", "editor");

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

    // Geometry is computed here, once per clip, rather than in the client:
    // the clamp rule belongs with the audio cut that shares it.
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
        recordedAt: recordingInstant(row.filename, row.detectionStart),
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

