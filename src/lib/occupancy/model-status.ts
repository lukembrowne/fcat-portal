/**
 * Per-species model-status classifier (read-time).
 *
 * A species that passes the data-readiness gate (src/lib/occupancy/eligibility.ts)
 * can still fail to produce a usable occupancy estimate: when it is detected at
 * nearly every site, the `occu` fit corrects naïve occupancy upward toward the
 * ψ=1 boundary, so EVERY variant (gradient / habitat / null) separates at the ψ
 * intercept (see ./separation.ts) and is stored `sufficient_data = 0` with a null
 * estimate. Those rows are filtered out of every `sufficient_data = true` query,
 * so such species silently vanish from the readiness table's ψ/p columns and from
 * the cross-species synthesis — biasing the synthesis against the MOST common
 * species and confusing the field team (badge says "Listo para modelar" but ψ/p
 * show "—" with no reason).
 *
 * This turns a species' stored variant rows into an explicit verdict + Spanish
 * reason, derived entirely from already-persisted fields (no re-fit, no schema
 * change), so the fix is visible immediately on existing runs:
 *  - `modeled`  — at least one variant is identifiable; carries the AIC-preferred ψ/p.
 *  - `ceiling`  — eligible but every fitted variant separated AND naïve occupancy
 *                 is high (≥ CEILING_NAIVE_OCCUPANCY): "casi ubicua", ψ at the
 *                 boundary, not estimable as a point with CI.
 *  - `unfit`    — eligible but every fitted variant separated for another reason
 *                 (low naïve occupancy): a generic "no estimable" state.
 *
 * Ineligible species (only a `combined` gate row) return `null` — their state is
 * handled live by the readiness table's "Datos insuficientes" path.
 */
import { preferredByAic } from "./meta-analysis";

/** Naïve occupancy at/above which an all-variants-separated species is "casi ubicua". */
export const CEILING_NAIVE_OCCUPANCY = 0.85;

export type ModelStatusKind = "modeled" | "ceiling" | "unfit";

/** One `occupancy_models` row for a species×stream (fields the classifier needs). */
export interface ModelVariantRow {
  species: string;
  stream: string;
  variant: string;
  sufficientData: boolean;
  estimatedOccupancy: number | null;
  meanDetection: number | null;
  naiveOccupancy: number | null;
  nSites: number;
  nSitesDetected: number;
  aic: number | null;
  ineligibleReasonsJson: string | null;
}

export interface SpeciesModelStatus {
  species: string;
  stream: string;
  kind: ModelStatusKind;
  /** Fitted ψ / p (present only when kind === "modeled"). */
  psi: number | null;
  p: number | null;
  naiveOccupancy: number;
  nSites: number;
  nSitesDetected: number;
  /** Spanish, UI-facing reason (null when kind === "modeled"). */
  reason: string | null;
}

/** Spanish reason for a near-ubiquitous (ceiling) species. */
export function buildCeilingReason(
  nSitesDetected: number,
  nSites: number,
  naiveOccupancy: number,
): string {
  const pct = Math.round(naiveOccupancy * 100);
  return (
    `Casi ubicua — detectada en ${nSitesDetected} de ${nSites} sitios (${pct}%); ` +
    `ocupación en el límite (≈100%), no estimable como punto con IC.`
  );
}

/** First Spanish reason from a stored `ineligible_reasons_json` array, if any. */
function firstStoredReason(json: string | null): string | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string") {
      return parsed[0];
    }
  } catch {
    // Malformed JSON → fall through to the caller's default.
  }
  return null;
}

/**
 * Classify all `occupancy_models` rows for ONE species×stream. Returns `null` for
 * species that only have the legacy ineligible `combined` gate row (their
 * un-modeled state is surfaced live by the readiness gate, not here).
 */
export function classifyModelStatus(rows: ModelVariantRow[]): SpeciesModelStatus | null {
  // 'combined' rows are the ineligible-gate legacy row — never a real fit.
  const fitted = rows.filter((r) => r.variant !== "combined");
  if (fitted.length === 0) return null;

  const base = fitted[0];
  const naive = base.naiveOccupancy ?? 0;
  const common = {
    species: base.species,
    stream: base.stream,
    naiveOccupancy: naive,
    nSites: base.nSites,
    nSitesDetected: base.nSitesDetected,
  };

  const modeled = fitted.filter((r) => r.sufficientData && r.estimatedOccupancy != null);
  if (modeled.length > 0) {
    const pref = preferredByAic(modeled) ?? modeled[0];
    return {
      ...common,
      kind: "modeled",
      psi: pref.estimatedOccupancy,
      p: pref.meanDetection,
      reason: null,
    };
  }

  if (naive >= CEILING_NAIVE_OCCUPANCY) {
    return {
      ...common,
      kind: "ceiling",
      psi: null,
      p: null,
      reason: buildCeilingReason(base.nSitesDetected, base.nSites, naive),
    };
  }

  return {
    ...common,
    kind: "unfit",
    psi: null,
    p: null,
    reason: firstStoredReason(base.ineligibleReasonsJson) ?? "Modelo no estimable.",
  };
}
