/**
 * Landowner-scoped Spanish copy + small pure UI helpers for the public farmer
 * page (`/public/biochoco/[token]`). Kept separate from the shared BioChocó
 * overview `content.ts` (which holds English strings feeding the overview page)
 * so this audience-specific copy can evolve independently.
 */

import type { SiteSpecies } from "@/app/biochoco/resultados/types";
import { iucnChip } from "./iucn-chip";

/**
 * The "Sobre el proyecto BioChoco" blurb (user-approved). Feeds the
 * projectContext block that the public page renders directly under the video.
 */
export const PROJECT_CONTEXT_BLURB =
  "El Chocó es uno de los bosques lluviosos más biodiversos de la Tierra, y más del 95% de su bosque original ya ha desaparecido. Lo que queda es un mosaico de bosque, fincas de cacao y pastizal. ¿Cómo responde la biodiversidad a estos cambios en el uso de la tierra? ¿Cómo podemos diseñar intervenciones de conservación que maximicen los beneficios para las comunidades locales y la biodiversidad? BioChocó trabaja para responder estas preguntas.";

/**
 * Landowner-facing display name for the public hero title. Site names are stored
 * as "<internal-code> - <person/place name>" (e.g. "GIZ-009 - Carla
 * Barreto"); the landowner page leads with the name and drops the internal
 * code (jargon that means nothing to them). Splits on the " - " separator (the
 * code's own hyphen has no surrounding spaces, so "GIZ-009" is never split) and
 * returns the name portion. Falls back to the full string when there is no
 * separator (a bare code like "SEC-014", or a name-only site). Pure/testable.
 */
export function landownerDisplayName(siteName: string): string {
  const parts = siteName.split(" - ");
  if (parts.length >= 2) {
    const name = parts.slice(1).join(" - ").trim();
    if (name) return name;
  }
  return siteName.trim();
}

/**
 * The single Spanish share message reused for both `navigator.share({ text })`
 * and the wa.me deep link. The page URL is appended after it.
 */
export const PAGE_SHARE_MESSAGE = "Mira lo que vive en su tierra 🌿 — BioChocó";

/**
 * Build a WhatsApp deep link (`wa.me`) that pre-fills the share message plus the
 * public page URL. Pure — used by the page-level share button and its test.
 */
export function buildWhatsAppShareUrl(
  pageUrl: string,
  message: string = PAGE_SHARE_MESSAGE,
): string {
  return `https://wa.me/?text=${encodeURIComponent(`${message} ${pageUrl}`)}`;
}

/**
 * Plain-language, one-line meaning per IUCN category for the conservation-status
 * key shown to landowners. Codes match `iucn-chip.ts` (DD/unknown never appear —
 * `iucnChip` returns null for those, so the legend simply skips them).
 */
export const IUCN_MEANINGS: Record<string, string> = {
  LC: "Por ahora no corre peligro de desaparecer.",
  NT: "Podría estar en riesgo en los próximos años.",
  VU: "Enfrenta un riesgo alto de desaparecer.",
  EN: "Esta especie corre riesgo de desaparecer.",
  CR: "Está extremadamente cerca de desaparecer.",
  EW: "Ya no vive libre en la naturaleza.",
  EX: "Esta especie ya desapareció por completo.",
};

/** Severity order (least → most at risk) for a stable legend layout. */
const IUCN_SEVERITY_ORDER = ["LC", "NT", "VU", "EN", "CR", "EW", "EX"];

/**
 * Rank an IUCN code by conservation concern (higher = more at risk). Unassessed
 * / DD / unknown rank lowest (-1) so they sort to the bottom of the table.
 */
export function iucnSeverityRank(code: string | null): number {
  if (!code) return -1;
  const idx = IUCN_SEVERITY_ORDER.indexOf(code.trim().toUpperCase());
  return idx; // -1 for codes not in the list (e.g. DD)
}

/**
 * Landowner-facing common name for a species row: prefer the Spanish name, then
 * a generic common name, falling back to the scientific name. Pure.
 */
export function speciesCommonName(sp: {
  spanishName: string | null;
  commonName: string | null;
  speciesName: string;
}): string {
  return sp.spanishName || sp.commonName || sp.speciesName;
}

/**
 * Stable ordering for the "all species" table: most-at-risk first (tells the
 * conservation story), then by detection count (desc), then common name (A→Z).
 * Pure — returns a new array, does not mutate the input.
 */
export function sortSpeciesForTable<
  T extends {
    spanishName: string | null;
    commonName: string | null;
    speciesName: string;
    detectionCount: number;
    iucnStatus: string | null;
  },
>(species: T[]): T[] {
  return [...species].sort((a, b) => {
    const rank = iucnSeverityRank(b.iucnStatus) - iucnSeverityRank(a.iucnStatus);
    if (rank !== 0) return rank;
    if (b.detectionCount !== a.detectionCount)
      return b.detectionCount - a.detectionCount;
    return speciesCommonName(a).localeCompare(speciesCommonName(b), "es");
  });
}

/**
 * The IUCN codes actually present among a site's species, in severity order,
 * excluding DD/unknown (anything `iucnChip` maps to null). Pure — drives the
 * conservation-status key so it only lists statuses this site's species carry.
 */
export function presentIucnStatuses(
  species: Pick<SiteSpecies, "iucnStatus">[],
): string[] {
  const present = new Set<string>();
  for (const s of species) {
    if (iucnChip(s.iucnStatus)) {
      present.add((s.iucnStatus as string).trim().toUpperCase());
    }
  }
  return IUCN_SEVERITY_ORDER.filter((code) => present.has(code));
}

/**
 * Compact one-line stats caption for the species showcase heading, e.g.
 * "3 especies · 150 detecciones · 1 ave · 2 mamíferos". Empty taxonomic groups
 * are omitted; all counts pluralize. Pure — relocated here from the (deleted)
 * species carousel so the merged showcase and its test can share it.
 */
export function buildSpeciesStatsText(species: SiteSpecies[]): string {
  const speciesCount = species.length;
  const detections = species.reduce((sum, s) => sum + s.detectionCount, 0);
  const birds = species.filter((s) => s.taxonomicType === "bird").length;
  const mammals = species.filter((s) => s.taxonomicType === "mammal").length;

  const parts = [
    `${speciesCount} ${speciesCount === 1 ? "especie" : "especies"}`,
    `${detections} ${detections === 1 ? "detección" : "detecciones"}`,
  ];
  if (birds > 0) parts.push(`${birds} ${birds === 1 ? "ave" : "aves"}`);
  if (mammals > 0)
    parts.push(`${mammals} ${mammals === 1 ? "mamífero" : "mamíferos"}`);

  return parts.join(" · ");
}

/** Spanish aria-labels for the fullscreen-gallery prev/next arrows. */
export const LIGHTBOX_PREV_LABEL = "Imagen anterior";
export const LIGHTBOX_NEXT_LABEL = "Imagen siguiente";

/**
 * Pure helper: which desktop arrows to show for a given gallery position. Prev
 * hides at the first image, next at the last; both hide when there's ≤1 image.
 * Relocated here from the (deleted) species lightbox; still used by the
 * featured-photo `StarredGalleryLightbox`.
 */
export function lightboxArrowState(
  current: number,
  total: number,
): { showPrev: boolean; showNext: boolean } {
  return {
    showPrev: total > 1 && current > 0,
    showNext: total > 1 && current < total - 1,
  };
}

/**
 * Seed for the fullscreen featured-photo gallery (U11): the tapped tile opens a
 * viewer over the FULL starred set, starting at the tapped image. When the site
 * has no starred photos the block's own imageIds are used as the fallback set.
 * Pure — testable without rendering.
 */
export function starredGallerySeed(
  starredIds: number[],
  blockIds: number[],
  tappedId: number,
): { ids: number[]; startIndex: number } {
  const ids = starredIds.length > 0 ? starredIds : blockIds;
  const idx = ids.indexOf(tappedId);
  return { ids, startIndex: idx >= 0 ? idx : 0 };
}
