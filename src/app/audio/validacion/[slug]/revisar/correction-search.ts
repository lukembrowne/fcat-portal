/**
 * Pure search and keyboard logic for the "¿Qué especie era?" picker that
 * follows a "No" on the review page.
 *
 * Separate from the component for the same reason `resolveReviewKey` is: Vitest
 * runs in `node` with no DOM, so the behaviour that matters — which key skips,
 * which chooses, what a query matches — is only testable as plain functions.
 */

import type {
  CorrectionSpeciesList,
  CorrectionSpeciesOption,
} from "@/app/audio/validacion/actions";
import { normalizeSpeciesName } from "@/app/audio/validacion/species-import";
import { describeDisplayName, type NameLang } from "@/app/audio/validacion/name-language";

export interface CorrectionEntry {
  scientificName: string;
  commonName: string;
  spanishName: string | null;
  /** Heard at least once in the caller's projects — ranked ahead. */
  detected: boolean;
  /** Position in the server's ranking (detected by count, then alphabetical). */
  rank: number;
  /** Normalised names, precomputed once rather than on every keystroke. */
  keys: string[];
}

/** How many matches the list renders. The full vocabulary is ~6.5k labels. */
export const MAX_RESULTS = 30;

/**
 * Flatten the server's two lists into one ranked index, dropping the species
 * being validated: "it was really itself" is a "Sí", and the server refuses it.
 */
export function buildCorrectionIndex(
  list: CorrectionSpeciesList,
  campaignSpecies: string
): CorrectionEntry[] {
  const out: CorrectionEntry[] = [];
  const add = (option: CorrectionSpeciesOption, detected: boolean) => {
    const [scientificName, commonName, spanishName] = option;
    if (scientificName === campaignSpecies) return;
    out.push({
      scientificName,
      commonName,
      spanishName,
      detected,
      rank: out.length,
      keys: [scientificName, commonName, spanishName ?? ""]
        .filter(Boolean)
        .map(normalizeSpeciesName),
    });
  };
  for (const option of list.detected) add(option, true);
  for (const option of list.others) add(option, false);
  return out;
}

const BOUNDARY = new Set([undefined, " ", "-"]);

/**
 * How well one name matches, lower is better, or null:
 * 0 whole-name prefix, 1 a whole word ("sparrow" in "White-throated Sparrow"),
 * 1.5 a word prefix ("sparrow" in "Japanese Sparrowhawk"), 2 substring.
 */
function nameScore(key: string, q: string): number | null {
  if (key.startsWith(q)) return 0;
  let best: number | null = null;
  for (let at = key.indexOf(q); at >= 0; at = key.indexOf(q, at + 1)) {
    const startsWord = BOUNDARY.has(key[at - 1]);
    const endsWord = BOUNDARY.has(key[at + q.length]);
    const s = startsWord ? (endsWord ? 1 : 1.5) : 2;
    if (best === null || s < best) best = s;
  }
  return best;
}

/**
 * Match a query against scientific, English and Spanish names, ignoring case
 * and accents ("garcita" finds "Garcita Estriada"). A multi-word query also
 * matches when every word appears somewhere across the names, so
 * "buteo platy" finds "Buteo platypterus".
 *
 * An empty query returns the detected species, the likeliest answers.
 */
export function searchCorrections(
  index: CorrectionEntry[],
  query: string,
  limit = MAX_RESULTS
): CorrectionEntry[] {
  const q = normalizeSpeciesName(query);
  if (!q) return index.filter((e) => e.detected).slice(0, limit);

  const tokens = q.split(" ");
  const scored: Array<[CorrectionEntry, number]> = [];
  for (const entry of index) {
    let best: number | null = null;
    for (const key of entry.keys) {
      const s = nameScore(key, q);
      if (s !== null && (best === null || s < best)) best = s;
    }
    if (best === null && tokens.length > 1) {
      const all = entry.keys.join(" ");
      if (tokens.every((t) => all.includes(t))) best = 3;
    }
    if (best !== null) scored.push([entry, best]);
  }
  scored.sort(
    (a, b) =>
      a[1] - b[1] ||
      Number(b[0].detected) - Number(a[0].detected) ||
      a[0].rank - b[0].rank
  );
  return scored.slice(0, limit).map(([entry]) => entry);
}

/** The name a reader asked for, per the validation pages' language cookie. */
export function correctionLabel(entry: CorrectionEntry, lang: NameLang): string {
  return describeDisplayName(entry, lang).name;
}

export type PickerIntent =
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "choose"; index: number }
  | { kind: "skip" }
  | { kind: "back" }
  | { kind: "clear" }
  | { kind: "release" }
  | null;

export interface PickerKeyContext {
  query: string;
  /** Highlighted row, or -1 when the reviewer has not moved into the list. */
  activeIndex: number;
  resultCount: number;
}

/**
 * Keys inside the picker's input.
 *
 * The page-wide shortcuts are suppressed while the input has focus (that is
 * what stops a typed "s" from answering the clip), so the two that must still
 * work from here — skip and back — are handled explicitly, and only while the
 * box is EMPTY: with text in it, the arrows move the caret.
 *
 * Enter on an empty box skips even though the detected species are listed
 * under it; it only chooses once the reviewer has typed or arrowed into the
 * list. Otherwise the most-detected species would be one stray Enter away from
 * being recorded as the truth.
 */
export function resolvePickerKey(key: string, ctx: PickerKeyContext): PickerIntent {
  const empty = ctx.query.trim() === "";
  switch (key) {
    case "ArrowDown":
      return ctx.resultCount > 0 ? { kind: "move", delta: 1 } : null;
    case "ArrowUp":
      return ctx.resultCount > 0 ? { kind: "move", delta: -1 } : null;
    case "Enter":
      if (ctx.activeIndex >= 0 && ctx.activeIndex < ctx.resultCount) {
        return { kind: "choose", index: ctx.activeIndex };
      }
      if (empty) return { kind: "skip" };
      return ctx.resultCount > 0 ? { kind: "choose", index: 0 } : null;
    case "ArrowRight":
      return empty ? { kind: "skip" } : null;
    case "ArrowLeft":
      return empty ? { kind: "back" } : null;
    case "Escape":
      // First Esc clears the text; a second hands the keyboard back to the
      // page shortcuts without advancing.
      return empty ? { kind: "release" } : { kind: "clear" };
    default:
      return null;
  }
}

/** Wrap-free movement through the result list; -1 means "back in the box". */
export function moveActive(active: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  return Math.max(-1, Math.min(count - 1, active + delta));
}

/** Rows the open list must be able to show before it prefers the other side. */
const LIST_MIN_ROWS_PX = 6 * 34;
/** The list's own ceiling: about eight rows. */
const LIST_MAX_PX = 288;
/** Breathing room kept between the list and the viewport edge. */
const LIST_EDGE_PX = 8;

export interface ListPlacement {
  side: "below" | "above";
  maxHeight: number;
}

/**
 * Where the suggestion list opens, from the input's viewport rectangle.
 *
 * The list is an overlay — pushing the page down would move the navigation
 * row on every keystroke — so it has to fit in whatever space the input
 * leaves. Downward is the default and wins whenever ~6 rows fit; otherwise it
 * takes the roomier side, capped to that side's space.
 */
export function listPlacement(
  rect: { top: number; bottom: number },
  viewportHeight: number
): ListPlacement {
  const below = Math.max(0, viewportHeight - rect.bottom - LIST_EDGE_PX);
  const above = Math.max(0, rect.top - LIST_EDGE_PX);
  const side = below >= LIST_MIN_ROWS_PX || below >= above ? "below" : "above";
  const room = side === "below" ? below : above;
  return { side, maxHeight: Math.max(0, Math.min(LIST_MAX_PX, room)) };
}
