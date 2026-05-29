import "server-only";
import { db } from "@/db";
import {
  systemEvents,
  type EventSeverity,
  type EventSource,
  type ProcessingJob,
} from "@/db/schema";
import { JOB_TYPES, type JobType } from "@/lib/job-types";
import { log } from "@/lib/log";

/**
 * Unified activity log writer. Every significant event in the portal — cron
 * runs, admin actions, destructive user actions, ingestion uploads, etc. —
 * flows through this helper into the `system_events` table, which backs the
 * `/admin/activity` page.
 *
 * Never throws. A failed insert is logged at `warn` and discarded so the
 * caller's primary flow is never broken by an event-recording problem.
 *
 * When `occurredAt` is omitted, the SQL DEFAULT `unixepoch()` fires
 * server-side.
 */
export type RecordEventInput = {
  source: EventSource;
  eventType: string;
  summary: string;
  severity?: EventSeverity;
  actorEmail?: string | null;
  projectId?: string | null;
  targetType?: string | null;
  targetId?: string | number | null;
  durationMs?: number | null;
  details?: Record<string, unknown> | null;
  occurredAt?: Date;
};

export async function recordEvent(input: RecordEventInput): Promise<void> {
  try {
    await db.insert(systemEvents).values({
      source: input.source,
      eventType: input.eventType,
      summary: input.summary,
      severity: input.severity ?? "info",
      actorEmail: input.actorEmail ?? null,
      projectId: input.projectId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId == null ? null : String(input.targetId),
      durationMs: input.durationMs ?? null,
      details: input.details ? JSON.stringify(input.details) : null,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    });
  } catch (err) {
    log.warn({ err, input }, "recordEvent_failed");
  }
}

// ---------------------------------------------------------------------------
// Job lifecycle helper
//
// Encodes the source / severity / eventType / projectId / summary mapping for
// `processing_jobs` terminal transitions in one place so the 28 lifecycle
// sites stay consistent. Pure function on an already-written row — does NOT
// touch the DB. The plan rejected a state-machine wrapper around job
// transitions; this is the payload counterpart, not that wrapper.
//
// Adding a new job type requires extending JOB_LABELS (and AUDIO_JOB_TYPES if
// it lives under the audio source) — the coverage-guard test will fail if you
// don't.
// ---------------------------------------------------------------------------

type TerminalOutcome = "completed" | "failed" | "cancelled";

const AUDIO_JOB_TYPES = new Set<JobType>([
  JOB_TYPES.BIRDNET,
  JOB_TYPES.ACOUSTIC_INDICES,
  JOB_TYPES.AUDIO_ANALYSIS,
  JOB_TYPES.AUDIO_SYNC,
  JOB_TYPES.AUDIO_COMPRESSION,
  JOB_TYPES.REVERT_AUDIO_COMPRESSION,
]);

export const JOB_LABELS: Record<JobType, string> = {
  ml: "Detección en cámaras trampa",
  ml_incremental: "Detección incremental en cámaras trampa",
  drive_sync: "Sincronización Drive",
  compression: "Compresión de imágenes",
  revert_compression: "Reversión de compresión",
  birdnet: "BirdNET",
  acoustic_indices: "Índices acústicos",
  audio_analysis: "Análisis de audio",
  audio_sync: "Sincronización de audio",
  audio_compression: "Compresión FLAC",
  revert_audio_compression: "Reversión de compresión FLAC",
  shared_drives_reconcile: "Reconciliación de Shared Drives",
  cache_deployment_images: "Caché de imágenes",
  training_export: "Exporte de entrenamiento",
  training_export_upload: "Subida de exporte",
};

const OUTCOME_VERBS: Record<TerminalOutcome, string> = {
  completed: "completado",
  failed: "fallido",
  cancelled: "cancelado",
};

export type JobCompletionExtras = Record<string, unknown>;

function jobSourceAndProject(jobType: JobType, job: ProcessingJob): {
  source: EventSource;
  projectId: string;
  scope: string;
} {
  // Shared-drive reconciliation is portal-wide infra, not tied to a project.
  if (jobType === JOB_TYPES.SHARED_DRIVES_RECONCILE) {
    return {
      source: "shared-drives",
      projectId: "shared-drives",
      scope: "Todos los drives",
    };
  }

  const source: EventSource = AUDIO_JOB_TYPES.has(jobType)
    ? "audio"
    : "camera-trap";
  const projectId = job.cameraTrapProjectId
    ? `camera-trap:${job.cameraTrapProjectId}`
    : source === "audio"
      ? "grabaciones"
      : "camera-trap";
  const scope = job.deploymentId
    ? `Instalación ${job.deploymentId}`
    : job.cameraTrapProjectId
      ? `Proyecto ${job.cameraTrapProjectId}`
      : "Todos los proyectos";
  return { source, projectId, scope };
}

/**
 * Event fired exactly once when a job transitions from `pending` to
 * `processing` (gated by the atomic claim in `@/lib/job-queue`). Severity is
 * `info`. No duration — pair with the matching `.completed|.failed|.cancelled`
 * event for elapsed time.
 */
export function buildJobStartEvent(job: ProcessingJob): RecordEventInput {
  const jobType = job.jobType as JobType;
  const { source, projectId, scope } = jobSourceAndProject(jobType, job);
  const label = JOB_LABELS[jobType] ?? job.jobType;
  return {
    source,
    eventType: `${source}_${job.jobType}.started`,
    severity: "info",
    summary: `${label} iniciado · ${scope}`,
    actorEmail: job.createdBy ?? null,
    projectId,
    targetType: "processing_job",
    targetId: job.id,
  };
}

export function buildJobCompletionEvent(
  job: ProcessingJob,
  extras?: JobCompletionExtras,
): RecordEventInput {
  const outcome: TerminalOutcome =
    job.status === "completed"
      ? "completed"
      : job.status === "failed"
        ? "failed"
        : "cancelled";

  const jobType = job.jobType as JobType;
  const { source, projectId, scope } = jobSourceAndProject(jobType, job);

  const severity: EventSeverity =
    outcome === "completed"
      ? "success"
      : outcome === "failed"
        ? "error"
        : "warn";

  const durationMs = job.startedAt
    ? Date.now() - job.startedAt.getTime()
    : null;

  const label = JOB_LABELS[jobType] ?? job.jobType;

  return {
    source,
    eventType: `${source}_${job.jobType}.${outcome}`,
    severity,
    summary: `${label} ${OUTCOME_VERBS[outcome]} · ${scope}`,
    actorEmail: job.createdBy ?? null,
    projectId,
    targetType: "processing_job",
    targetId: job.id,
    durationMs,
    details: {
      ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
      ...(extras ?? {}),
    },
  };
}
