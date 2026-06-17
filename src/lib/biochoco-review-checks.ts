/**
 * BioChoco monthly data-quality review — pure check engine.
 *
 * These functions take an already-gathered, in-memory snapshot of every
 * deployment (see `gatherDeploymentReviewData` in `biochoco-review-core.ts`)
 * and return rule-based findings. They are intentionally **pure** (no DB,
 * Drive, ODK, or clock access) so the rules can be unit-tested deterministically
 * — the script computes the facts, this module computes the judgments' raw
 * material, and the skill prompt does the narrative/prioritization.
 *
 * Plan: docs/plans/2026-06-16-feat-biochoco-data-quality-review-skill-plan.md
 */

export type DataType = "camera" | "audio" | "ibutton";

export type ReviewLifecycle = "scheduled" | "deployed" | "retrieved";

export type Severity = "error" | "warn" | "info";

/** One deployment's merged, review-ready facts. Populated by the gather step. */
export interface ReviewDeployment {
  deploymentId: string;
  siteId: string;
  siteName: string | null;
  habitat: string;
  season: string;
  lifecycle: ReviewLifecycle;
  excluded: boolean;

  plannedDeployDate: string | null; // "YYYY-MM-DD"
  plannedRetrieveDate: string | null;
  actualDeployDate: string | null;
  actualRetrieveDate: string | null;

  latitude: number | null;
  longitude: number | null;

  /** Which data types this deployment is expected to have produced. */
  expectedTypes: DataType[];
  expectedTypesSource: "folders" | "fallback-all";

  counts: {
    camera: number | null;
    audio: number | null;
    ibutton: number | null;
  };
  countsCheckedAt: number | null; // unix seconds
  /** Non-null when the live Drive re-count failed for this deployment. */
  recountError: string | null;
  newestUploadDate: string | null;

  // Processing health (camera-trap ML)
  processingStatus:
    | "unscanned"
    | "scanned"
    | "processing"
    | "processed"
    | "verified"
    | "verified_empty"
    | null;
  failedJobs: number;
  failedImages: number;

  // iButton coverage (null when window/sample-rate unknown)
  ibuttonRowsImported: number | null;
  ibuttonCoveragePct: number | null;

  // Camera image deployment-window QC (v1: images only)
  cameraOutOfWindow: boolean;
  cameraFilesOutsideWindow: number | null;

  fieldNotes: string | null;
}

export type CheckId =
  | "overdue_retrieval"
  | "overdue_installation"
  | "retrieved_no_data"
  | "partial_upload"
  | "missing_coordinates"
  | "recount_failed"
  | "files_outside_window"
  | "processing_health";

export interface ReviewFinding {
  check: CheckId;
  /** Optional finer-grained subtype (e.g. "failed_jobs" within processing_health). */
  subtype?: string;
  severity: Severity;
  deploymentId: string;
  siteName: string | null;
  habitat: string;
  /** Spanish, human-readable one-liner. */
  summary: string;
  evidence: Record<string, unknown>;
}

export interface CheckOptions {
  /** "YYYY-MM-DD" — the reference "today". */
  today: string;
  /** Days overdue beyond which severity escalates from warn to error. */
  overdueErrorDays?: number;
  /** iButton coverage % below which we flag low coverage. */
  lowCoverageThreshold?: number;
}

const DAY_MS = 86_400_000;

/** Whole days between two "YYYY-MM-DD" strings (a - b). Null if unparseable. */
export function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((ta - tb) / DAY_MS);
}

function count(d: ReviewDeployment, t: DataType): number {
  return d.counts[t] ?? 0;
}

function typeLabel(t: DataType): string {
  return t === "camera" ? "cámaras" : t === "audio" ? "audio" : "iButton";
}

/**
 * Run all eight checks over the deployment set. Excluded deployments are
 * skipped (they're QA-excluded on purpose); callers should report their count
 * separately. Findings are returned flat; the skill groups/prioritizes them.
 */
export function runChecks(
  deps: ReviewDeployment[],
  opts: CheckOptions
): ReviewFinding[] {
  const today = opts.today;
  const overdueErrorDays = opts.overdueErrorDays ?? 14;
  const lowCoverage = opts.lowCoverageThreshold ?? 95;
  const findings: ReviewFinding[] = [];

  const base = (d: ReviewDeployment) => ({
    deploymentId: d.deploymentId,
    siteName: d.siteName,
    habitat: d.habitat,
  });

  for (const d of deps) {
    if (d.excluded) continue;

    // 1. Overdue retrieval — installed, not retrieved, past planned retrieve date.
    if (
      d.lifecycle === "deployed" &&
      d.plannedRetrieveDate &&
      d.plannedRetrieveDate < today
    ) {
      const daysOverdue = daysBetween(today, d.plannedRetrieveDate);
      findings.push({
        check: "overdue_retrieval",
        severity:
          daysOverdue !== null && daysOverdue > overdueErrorDays
            ? "error"
            : "warn",
        ...base(d),
        summary:
          daysOverdue !== null
            ? `Recuperación vencida hace ${daysOverdue} días`
            : `Recuperación vencida (fecha plan ${d.plannedRetrieveDate})`,
        evidence: {
          plannedRetrieveDate: d.plannedRetrieveDate,
          actualDeployDate: d.actualDeployDate,
          daysOverdue,
        },
      });
    }

    // 2. Overdue installation — scheduled, never installed, past planned deploy date.
    if (
      d.lifecycle === "scheduled" &&
      d.plannedDeployDate &&
      d.plannedDeployDate < today
    ) {
      const daysOverdue = daysBetween(today, d.plannedDeployDate);
      findings.push({
        check: "overdue_installation",
        severity:
          daysOverdue !== null && daysOverdue > overdueErrorDays
            ? "error"
            : "warn",
        ...base(d),
        summary:
          daysOverdue !== null
            ? `Instalación vencida hace ${daysOverdue} días`
            : `Instalación vencida (fecha plan ${d.plannedDeployDate})`,
        evidence: { plannedDeployDate: d.plannedDeployDate, daysOverdue },
      });
    }

    // Upload-completeness checks only make sense once retrieved and we trust the count.
    const recountTrusted = d.lifecycle === "retrieved" && !d.recountError;

    // 3. Retrieved but no data uploaded.
    if (recountTrusted) {
      const total =
        count(d, "camera") + count(d, "audio") + count(d, "ibutton");
      if (total === 0) {
        const daysSince = d.actualRetrieveDate
          ? daysBetween(today, d.actualRetrieveDate)
          : null;
        findings.push({
          check: "retrieved_no_data",
          severity: "error",
          ...base(d),
          summary: "Recuperada sin datos subidos en Drive",
          evidence: {
            actualRetrieveDate: d.actualRetrieveDate,
            daysSinceRetrieval: daysSince,
            counts: d.counts,
          },
        });
      }
    }

    // 4. Partial upload — some expected types present, some missing.
    if (recountTrusted && d.expectedTypes.length > 0) {
      const present = d.expectedTypes.filter((t) => count(d, t) > 0);
      const missing = d.expectedTypes.filter((t) => count(d, t) === 0);
      if (present.length > 0 && missing.length > 0) {
        findings.push({
          check: "partial_upload",
          // When the expectation is only a fallback guess, soften to info.
          severity: d.expectedTypesSource === "fallback-all" ? "info" : "warn",
          ...base(d),
          summary: `Datos parciales: falta ${missing
            .map(typeLabel)
            .join(", ")}`,
          evidence: {
            expectedTypes: d.expectedTypes,
            expectedTypesSource: d.expectedTypesSource,
            missing,
            present,
            counts: d.counts,
          },
        });
      }
    }

    // 5. Missing coordinates.
    if (d.latitude == null || d.longitude == null) {
      findings.push({
        check: "missing_coordinates",
        severity: d.lifecycle === "scheduled" ? "warn" : "error",
        ...base(d),
        summary: "Sin coordenadas (latitud/longitud)",
        evidence: {
          latitude: d.latitude,
          longitude: d.longitude,
          siteId: d.siteId,
          lifecycle: d.lifecycle,
        },
      });
    }

    // 6. Re-count failed → upload status unknown.
    if (d.recountError) {
      findings.push({
        check: "recount_failed",
        severity: "warn",
        ...base(d),
        summary: "No se pudo verificar el conteo en Google Drive",
        evidence: { recountError: d.recountError },
      });
    }

    // 7. Files outside the deployment window (v1: camera images).
    if (d.cameraOutOfWindow) {
      const n = d.cameraFilesOutsideWindow;
      findings.push({
        check: "files_outside_window",
        subtype: "camera",
        severity: "warn",
        ...base(d),
        summary:
          n != null
            ? `${n} imágenes fuera de la ventana de despliegue`
            : "Imágenes fuera de la ventana de despliegue",
        evidence: {
          cameraFilesOutsideWindow: n,
          actualDeployDate: d.actualDeployDate,
          actualRetrieveDate: d.actualRetrieveDate,
        },
      });
    }

    // 8. Processing health: failed jobs/images, low iButton coverage, awaiting verification.
    if (d.failedJobs > 0 || d.failedImages > 0) {
      findings.push({
        check: "processing_health",
        subtype: "processing_failures",
        severity: "warn",
        ...base(d),
        summary:
          d.failedImages > 0
            ? `${d.failedImages} imágenes fallaron en el procesamiento`
            : `${d.failedJobs} trabajos de procesamiento fallidos`,
        evidence: { failedJobs: d.failedJobs, failedImages: d.failedImages },
      });
    }

    if (d.ibuttonCoveragePct != null && d.ibuttonCoveragePct < lowCoverage) {
      findings.push({
        check: "processing_health",
        subtype: "ibutton_low_coverage",
        severity: "warn",
        ...base(d),
        summary: `Cobertura iButton baja: ${d.ibuttonCoveragePct}%`,
        evidence: {
          ibuttonCoveragePct: d.ibuttonCoveragePct,
          ibuttonRowsImported: d.ibuttonRowsImported,
        },
      });
    }

    if (d.processingStatus === "processed") {
      findings.push({
        check: "processing_health",
        subtype: "awaiting_verification",
        severity: "info",
        ...base(d),
        summary: "Procesada por ML, pendiente de verificación humana",
        evidence: { processingStatus: d.processingStatus },
      });
    }
  }

  return findings;
}

/** Summarize findings by severity for the executive header. */
export function summarizeFindings(findings: ReviewFinding[]): {
  error: number;
  warn: number;
  info: number;
  byCheck: Record<string, number>;
} {
  const out = {
    error: 0,
    warn: 0,
    info: 0,
    byCheck: {} as Record<string, number>,
  };
  for (const f of findings) {
    out[f.severity]++;
    out.byCheck[f.check] = (out.byCheck[f.check] ?? 0) + 1;
  }
  return out;
}
