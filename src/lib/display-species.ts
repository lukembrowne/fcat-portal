/**
 * Display-time confidence threshold for camera trap identifications.
 *
 * Camera trap identifications are stored with the raw top-1 prediction
 * and raw confidence the model produced. The threshold lives on the model
 * row, not on the identification — so re-tuning a threshold is a single
 * UPDATE on `camera_trap_models.confidence_threshold` rather than a
 * full reprocess. This helper applies the threshold at read time.
 *
 * Pure function — server- and client-safe, fully unit-testable.
 *
 * Legacy AI4G identifications have `classifierModelId === null` and are
 * returned as-is (there's no per-model threshold to apply).
 */

export interface IdentForDisplay {
  species: string;
  confidence: number;
  classifierModelId: number | null;
}

export interface ModelForDisplay {
  confidenceThreshold: number;
}

export interface DisplayedSpecies {
  label: string;
  lowConfidence: boolean;
}

export const LOW_CONFIDENCE_LABEL = "Sin identificar";

export function displaySpecies(
  ident: IdentForDisplay,
  modelById: Map<number, ModelForDisplay>,
): DisplayedSpecies {
  // Legacy AI4G ident — no per-model threshold, return as-is.
  if (ident.classifierModelId == null) {
    return { label: ident.species, lowConfidence: false };
  }

  const model = modelById.get(ident.classifierModelId);
  // If we have an FK but the model row was deleted (shouldn't happen — the
  // FK is ON DELETE SET NULL — but be safe), fall back to raw.
  if (!model) {
    return { label: ident.species, lowConfidence: false };
  }

  if (ident.confidence >= model.confidenceThreshold) {
    return { label: ident.species, lowConfidence: false };
  }

  return { label: LOW_CONFIDENCE_LABEL, lowConfidence: true };
}
