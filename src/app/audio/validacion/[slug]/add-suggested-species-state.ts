/**
 * Whether the suggestions-only page offers "Añadir especie a validación".
 *
 * A plain module (not the `"use client"` button file) so the Server Component
 * page can call it.
 *
 * `createCampaign` draws the sample as part of adding the species, and a draw
 * with nothing to draw from leaves the species behind in `draft` — a permanent
 * amber row that no "Preparar" can ever fix. A reviewer can name a species that
 * BirdNET never predicted in the caller's projects (the picker offers the whole
 * BirdNET list), so the button is disabled, with the reason, until there is
 * something to draw.
 */

export type AddSuggestedSpeciesState =
  | { kind: "hidden" }
  | { kind: "enabled" }
  | { kind: "disabled"; reason: string };

export function addSuggestedSpeciesState(
  canEdit: boolean,
  /** Detections the draw could find for this species in the caller's scope. */
  drawableDetections: number
): AddSuggestedSpeciesState {
  if (!canEdit) return { kind: "hidden" };
  if (drawableDetections > 0) return { kind: "enabled" };
  return {
    kind: "disabled",
    reason:
      "No se puede añadir: BirdNET no tiene detecciones de esta especie en tus proyectos, así que no hay clips para extraer una muestra.",
  };
}
