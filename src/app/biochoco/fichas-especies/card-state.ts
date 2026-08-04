/**
 * Per-card save state for the fichas de especies editor.
 *
 * Cards keep a local `draft` and are always mounted, so "has this changed?" and
 * "what should the footer say?" are asked on every keystroke across ~63 cards.
 * Both answers are pure functions here rather than component state, because
 * vitest runs in a node environment with no jsdom — this is the only layer where
 * the transitions can actually be tested.
 *
 * Error contract: the caller clears `error` when the author edits, so a stale
 * rejection never sticks to text that has since changed. `deriveStatus` only has
 * to rank the states, not decide whether an error is still current.
 */

import { SPECIES_CONTENT_MAX } from "./content-types";

/**
 * How long "Guardado" stays up after a successful save. The card sets a timer
 * for this and flips `saved` back off — deliberately the ONE place the window
 * is enforced, so `deriveStatus` can stay a pure function of state with no
 * clock reading during render (which React's purity lint rejects, correctly:
 * a re-render for any unrelated reason would re-evaluate the window).
 */
export const SAVED_WINDOW_MS = 2000;

export type CardStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export interface CardStateInput {
  draft: string;
  stored: string | null;
  pending: boolean;
  error: string | null;
  /** True inside the post-save confirmation window; the card's timer clears it. */
  saved: boolean;
}

/**
 * Normalize the way the server does (`updateSpeciesContent` trims and stores
 * whitespace-only as NULL), so `""` and `null` are the same value and a stray
 * trailing newline is not an edit.
 */
function normalize(value: string | null): string {
  return (value ?? "").trim();
}

export function isDirty(draft: string, stored: string | null): boolean {
  return normalize(draft) !== normalize(stored);
}

/**
 * How many characters the draft is over {@link SPECIES_CONTENT_MAX}; 0 when it
 * fits. Measured on the TRIMMED value because that is what the server checks —
 * if the two disagreed, a draft could show as over-length while the save
 * succeeds (or the reverse), and the counter would contradict the button.
 *
 * The textarea deliberately has no `maxLength`: a hard cap silently truncates a
 * paste, which is worse than letting the author overshoot and telling them by
 * how much. The server-side check in `updateSpeciesContent` remains the real
 * enforcement — this is just the warning that gets there first.
 */
export function overBy(draft: string): number {
  return Math.max(0, normalize(draft).length - SPECIES_CONTENT_MAX);
}

/**
 * Rank order: saving > error > dirty > saved > idle.
 *
 * `dirty` outranking `saved` is what stops a card from claiming "Guardado"
 * while it holds text that has not been sent yet.
 */
export function deriveStatus({
  draft,
  stored,
  pending,
  error,
  saved,
}: CardStateInput): CardStatus {
  if (pending) return "saving";
  if (error) return "error";
  if (isDirty(draft, stored)) return "dirty";
  if (saved) return "saved";
  return "idle";
}
