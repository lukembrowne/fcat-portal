/**
 * Client-side review state: the reviewer's own answers this session and the
 * species they named for the clips they called wrong.
 *
 * Pure, so the flow the plan pins down ("No" pauses, "Sí"/"No sé" advance,
 * leaving "No" drops the correction, a failed correction keeps the clip up) is
 * testable without a DOM. The server is the authority for all of it —
 * `recordReview` clears a correction on its own when the outcome leaves
 * `incorrect` — this only keeps the screen in step without a refetch.
 *
 * `getReviewQueue` never returns an outcome or a correction; the caller's OWN
 * earlier ones arrive separately (`getMyRecentReviews` → `hydrateFlow`), so
 * going back to a clip shows what this reviewer chose and nothing a colleague
 * did.
 */

import type { ActionResult } from "@/lib/types";

export type Outcome = "correct" | "incorrect" | "uncertain";

export interface ReviewFlowState {
  answers: Record<number, Outcome>;
  /** Scientific name the reviewer says the clip really was. */
  corrections: Record<number, string>;
  /**
   * Per-clip answer generation: bumped by every answer (and rollback) on that
   * clip. A correction save captures it when sent and is dropped on return if
   * the clip has been answered again since — see `settleCorrection`.
   */
  versions: Record<number, number>;
  /**
   * The clip whose three answer buttons were reopened with "cambiar
   * respuesta" while it stays answered "No". Display-only: reopening changes
   * no answer, sends nothing, and leaves the answer generation alone, so a
   * correction already in flight still settles normally.
   */
  reopened: number | null;
}

export const EMPTY_FLOW: ReviewFlowState = {
  answers: {},
  corrections: {},
  versions: {},
  reopened: null,
};

/** The clip's current answer generation (0 before any answer). */
export function answerVersion(state: ReviewFlowState, sampleId: number): number {
  return state.versions[sampleId] ?? 0;
}

function bump(versions: Record<number, number>, sampleId: number): Record<number, number> {
  return { ...versions, [sampleId]: (versions[sampleId] ?? 0) + 1 };
}

function without<T>(record: Record<number, T>, key: number): Record<number, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** Record an answer. Anything but "No" drops the correction, as the server does. */
export function applyAnswer(
  state: ReviewFlowState,
  sampleId: number,
  outcome: Outcome
): ReviewFlowState {
  return {
    answers: { ...state.answers, [sampleId]: outcome },
    corrections:
      outcome === "incorrect" ? state.corrections : without(state.corrections, sampleId),
    versions: bump(state.versions, sampleId),
    // Any answer closes a reopened button row: "No" again asks for the
    // species again, the other two advance.
    reopened: null,
  };
}

/** What a clip held before an answer, so a refused change can put it back. */
export interface PriorAnswer {
  outcome: Outcome;
  correction: string | null;
}

/** The clip's answer and correction as they stand, or null when unanswered. */
export function priorAnswer(state: ReviewFlowState, sampleId: number): PriorAnswer | null {
  const outcome = state.answers[sampleId];
  if (!outcome) return null;
  return { outcome, correction: state.corrections[sampleId] ?? null };
}

/**
 * Undo an answer the server refused, so the count never overstates what was
 * saved. A clip that was already answered goes back to that answer — it is
 * still on the server — rather than reading as unanswered.
 */
export function rollbackAnswer(
  state: ReviewFlowState,
  sampleId: number,
  prior: PriorAnswer | null = null
): ReviewFlowState {
  return {
    answers: prior
      ? { ...state.answers, [sampleId]: prior.outcome }
      : without(state.answers, sampleId),
    corrections: prior?.correction
      ? { ...state.corrections, [sampleId]: prior.correction }
      : without(state.corrections, sampleId),
    versions: bump(state.versions, sampleId),
    reopened: state.reopened === sampleId ? null : state.reopened,
  };
}

/**
 * The flow for a page that opens with the caller's earlier answers loaded
 * behind the queue (`getMyRecentReviews`), so ← shows them after a reload.
 * Only the caller's own answers ever arrive here.
 */
export function hydrateFlow(
  history: Array<{ sampleId: number; outcome: Outcome; correctedSpecies: string | null }>
): ReviewFlowState {
  const answers: Record<number, Outcome> = {};
  const corrections: Record<number, string> = {};
  for (const h of history) {
    answers[h.sampleId] = h.outcome;
    if (h.outcome === "incorrect" && h.correctedSpecies) {
      corrections[h.sampleId] = h.correctedSpecies;
    }
  }
  return { answers, corrections, versions: {}, reopened: null };
}

export function applyCorrection(
  state: ReviewFlowState,
  sampleId: number,
  species: string | null
): ReviewFlowState {
  return {
    answers: state.answers,
    corrections:
      species === null
        ? without(state.corrections, sampleId)
        : { ...state.corrections, [sampleId]: species },
    versions: state.versions,
    reopened: state.reopened,
  };
}

/**
 * What the page does after an answer. "No" stays on the clip to ask what it
 * really was; the other two keep the old auto-advance.
 */
export function afterAnswer(outcome: Outcome): "advance" | "ask-species" {
  return outcome === "incorrect" ? "ask-species" : "advance";
}

/** The picker shows on any clip this reviewer has answered "No" — including on ←. */
export function showsSpeciesPicker(state: ReviewFlowState, sampleId: number): boolean {
  return state.answers[sampleId] === "incorrect";
}

/**
 * What fills the slot under the clip: the three answer buttons, or — on a clip
 * answered "No" — the compact "✕ Incorrecta · cambiar respuesta" line with the
 * species search beneath it. The buttons used to stay and the search appeared
 * BELOW them, which on a laptop put it under the fold on every "No".
 */
export function answerSlot(state: ReviewFlowState, sampleId: number): "buttons" | "species" {
  return showsSpeciesPicker(state, sampleId) && state.reopened !== sampleId
    ? "species"
    : "buttons";
}

/** "cambiar respuesta": bring the three buttons back WITHOUT touching the answer. */
export function reopenAnswer(state: ReviewFlowState, sampleId: number): ReviewFlowState {
  if (state.reopened === sampleId) return state;
  return { ...state, reopened: sampleId };
}

/** Navigation closes a reopened button row; coming back shows the compact line. */
export function closeReopened(state: ReviewFlowState): ReviewFlowState {
  return state.reopened === null ? state : { ...state, reopened: null };
}

export type CorrectionSave = (
  sampleId: number,
  species: string | null
) => Promise<ActionResult<{ correctedSpecies: string | null }>>;

export type CorrectionCommit =
  | { ok: true; species: string | null }
  | { ok: false; error: string };

/**
 * Save a correction, after the "No" it hangs on has landed.
 *
 * The wait matters: the answer is saved the instant "No" is pressed, and a
 * reviewer who types three letters and hits Enter can beat that round trip.
 * Sent first, the correction would be refused ("Primero responde…") for a
 * review that was about to exist. If that answer failed, there is nothing to
 * correct and the answer's own error is already on screen.
 */
export async function commitCorrection(
  sampleId: number,
  species: string | null,
  deps: { pendingAnswer?: Promise<boolean>; save: CorrectionSave }
): Promise<CorrectionCommit> {
  if (deps.pendingAnswer) {
    const saved = await deps.pendingAnswer;
    if (!saved) return { ok: false, error: "No se guardó la respuesta de esta detección" };
  }
  try {
    const result = await deps.save(sampleId, species);
    if (!result.success) return { ok: false, error: result.error };
    return { ok: true, species: result.data.correctedSpecies };
  } catch {
    return { ok: false, error: "No se pudo guardar la especie" };
  }
}

/** Shown in the picker when a correction came back for a superseded answer. */
export const STALE_CORRECTION_ERROR =
  "La respuesta de esta detección cambió mientras se guardaba la especie; vuelve a indicarla si hace falta.";

/**
 * Decide what a returned correction save does to the screen.
 *
 * The save is slow (it waits on the answer's own round trip first), and the
 * reviewer can re-answer the same clip meanwhile — press "Sí" after typing a
 * species, say. Applied blindly, the late result would record a correction
 * locally on a clip that is no longer "No" and advance, on top of the "Sí"'s
 * own 320 ms advance: two steps, one clip skipped. So a result is dropped —
 * no local correction, no advance — unless the clip is still answered "No"
 * AND no newer answer has been given since the save was sent (`version`).
 */
export function settleCorrection(
  state: ReviewFlowState,
  sampleId: number,
  version: number,
  commit: CorrectionCommit,
  chosen: string | null
): { state: ReviewFlowState; advance: boolean; commit: CorrectionCommit } {
  if (!commit.ok) return { state, advance: false, commit };
  const current =
    state.answers[sampleId] === "incorrect" && answerVersion(state, sampleId) === version;
  if (!current) {
    return { state, advance: false, commit: { ok: false, error: STALE_CORRECTION_ERROR } };
  }
  return {
    state: applyCorrection(state, sampleId, commit.species),
    advance: chosen !== null,
    commit,
  };
}

/**
 * A `setIndex` updater that advances only if the queue is still on `sampleId`.
 *
 * Every delayed advance goes through this: the 320 ms pause after "Sí"/"No sé"
 * and the advance after naming a species. An unguarded `i => i + 1` that fires
 * after the reviewer has already moved (skip, back, or a second advance)
 * silently skips a clip.
 */
export function advanceIfStillOn(
  items: ReadonlyArray<{ sampleId: number }>,
  sampleId: number
): (index: number) => number {
  return (i) => (items[i]?.sampleId === sampleId ? i + 1 : i);
}

export type NoteSave = (
  sampleId: number,
  note: string | null
) => Promise<ActionResult<{ note: string | null }>>;

export type NoteCommit = { ok: true; note: string | null } | { ok: false; error: string };

/**
 * Save a clip note, after the answer it hangs on has landed.
 *
 * Same wait as `commitCorrection`, for the same reason: a note typed before
 * answering is sent the moment the answer is, and would otherwise race it and
 * be refused ("Primero responde…") for a review about to exist. Unlike a
 * correction there is no staleness check — a note describes the clip, not the
 * answer, so a later answer change does not invalidate it.
 */
export async function commitNote(
  sampleId: number,
  note: string | null,
  deps: { pendingAnswer?: Promise<boolean>; save: NoteSave }
): Promise<NoteCommit> {
  if (deps.pendingAnswer) {
    const saved = await deps.pendingAnswer;
    if (!saved) return { ok: false, error: "No se guardó la respuesta de esta detección" };
  }
  try {
    const result = await deps.save(sampleId, note);
    if (!result.success) return { ok: false, error: result.error };
    return { ok: true, note: result.data.note };
  } catch {
    return { ok: false, error: "No se pudo guardar la nota" };
  }
}
