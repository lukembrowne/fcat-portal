/**
 * Link to a species' xeno-canto page.
 *
 * xeno-canto's species URLs are `/species/Genus-species`, so the scientific
 * name maps across with whitespace collapsed to a single hyphen. Shared rather
 * than inlined because three surfaces now link there — the audio species page,
 * the validation species page and the review screen — and a reviewer comparing
 * a clip against reference recordings should land in the same place from all
 * three.
 *
 * Deliberately NOT `speciesSlug`: that lowercases and strips for internal
 * routing, and xeno-canto's paths keep the capitalised genus.
 */
export function xenoCantoUrl(scientificName: string): string {
  const slug = scientificName.trim().replace(/\s+/g, "-");
  return `https://xeno-canto.org/species/${encodeURIComponent(slug)}`;
}
