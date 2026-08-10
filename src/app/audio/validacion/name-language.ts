/**
 * Spanish/English common-name preference for the validation pages.
 *
 * WHY A COOKIE: every surface here that renders a species name is a Server
 * Component. Client state plus localStorage would force each of them to become
 * or wrap a Client Component and would flash the wrong language on first paint;
 * a URL parameter would have to be threaded through every link and would
 * collide with the existing sortBy/sortDir params. A cookie is read on the
 * server, so each page renders the right name directly.
 *
 * Reading it opts the route into dynamic rendering, which costs nothing here —
 * all of these pages already call `requirePermission`, which reads headers.
 *
 * Nothing in this module is validation-specific, so a later portal-wide rollout
 * is a matter of importing it elsewhere. This change deliberately does not do
 * that: the scope is the validation pages.
 */

export const NAME_LANG_COOKIE = "fcat-nombres";

export type NameLang = "es" | "en";

/** Spanish is the portal's default; anything unrecognised falls back to it. */
export function parseNameLang(value: string | undefined | null): NameLang {
  return value === "en" ? "en" : "es";
}

export interface SpeciesNames {
  scientificName: string;
  commonName?: string | null;
  spanishName?: string | null;
}

/** Treat empty/whitespace strings as absent so a blank column never renders. */
function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Which rung of the fallback chain a displayed name came from.
 *
 * `"other-language"` is the case that reads as a broken toggle: the reader asks
 * for Spanish, the species has no Spanish name, and the header keeps showing
 * the English one. Nothing is wrong, but nothing appears to happen either, so
 * the surfaces that render a name say which rung they landed on.
 */
export type NameFallback = null | "other-language" | "scientific";

export interface DisplayName {
  name: string;
  fallback: NameFallback;
}

/**
 * The name to show, with an explicit fallback chain and which rung it used.
 *
 * Coverage is not total and the fallbacks are load-bearing: of 601 species rows,
 * 553 carry a Spanish name — so roughly one species in twelve cannot answer a
 * request for Spanish, and `Aramides wolfi` is one of them.
 */
export function describeDisplayName(sp: SpeciesNames, lang: NameLang): DisplayName {
  const scientific = sp.scientificName;
  const english = present(sp.commonName);
  const spanish = present(sp.spanishName);

  const preferred = lang === "en" ? english : spanish;
  if (preferred) return { name: preferred, fallback: null };

  const other = lang === "en" ? null : english;
  if (other) return { name: other, fallback: "other-language" };

  return { name: scientific, fallback: "scientific" };
}

/** The name alone, for the many callers that render nothing else. */
export function resolveDisplayName(sp: SpeciesNames, lang: NameLang): string {
  return describeDisplayName(sp, lang).name;
}

/**
 * Spanish note explaining a fallback, or null when the name is the asked-for
 * one. Phrased as a fact about the species, not an error about the toggle.
 */
export function fallbackNote(fallback: NameFallback, lang: NameLang): string | null {
  if (fallback === null) return null;
  // Under English the chain never borrows the Spanish name, so landing on the
  // scientific name means English is missing — not that no common name exists.
  if (lang === "en") return "sin nombre en inglés";
  return fallback === "scientific" ? "sin nombre común" : "sin nombre en español";
}

/** Label for the opposite language, for the toggle's button text. */
export function otherLangLabel(lang: NameLang): string {
  return lang === "es" ? "English" : "Español";
}
