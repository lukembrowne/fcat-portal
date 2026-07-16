/**
 * IUCN Red List category → Spanish label + severity color, for display on the
 * landowner public pages. Pure and null-safe: unknown/unassessed codes (DD,
 * empty, null, undefined, or anything unrecognized) return `null` so callers
 * can simply skip rendering a chip.
 *
 * Colors are hex values chosen to read well as a solid pill on a dark photo
 * scrim (white text sits on top of these).
 */

export interface IucnChip {
  /** Spanish label shown inside the chip. */
  label: string;
  /** Solid background hex color for the chip (white text reads on all of these). */
  color: string;
}

const CHIPS: Record<string, IucnChip> = {
  // Least Concern — green
  LC: { label: "Preocupación menor", color: "#15803d" },
  // Near Threatened — amber
  NT: { label: "Casi amenazado", color: "#b45309" },
  // Vulnerable — orange/red
  VU: { label: "Vulnerable", color: "#c2410c" },
  // Endangered — red
  EN: { label: "En peligro", color: "#b91c1c" },
  // Critically Endangered — deep red
  CR: { label: "En peligro crítico", color: "#7f1d1d" },
  // Extinct in the Wild / Extinct — near-black
  EW: { label: "Extinto en estado silvestre", color: "#1c1917" },
  EX: { label: "Extinto", color: "#0c0a09" },
};

/**
 * Map an IUCN Red List category code to a display chip. Case-insensitive.
 * Returns `null` for DD (Data Deficient), empty/whitespace, null, undefined,
 * or any unrecognized code.
 */
export function iucnChip(code: string | null | undefined): IucnChip | null {
  if (!code) return null;
  const key = code.trim().toUpperCase();
  if (!key) return null;
  return CHIPS[key] ?? null;
}
