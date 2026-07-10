/**
 * Cross-species predicted richness (U12): sum per-cell ψ across species'
 * prediction grids into an expected-species-count surface (Σψ). Cells are keyed
 * by rounded lat/lng so grids that share the AOI lattice align.
 */
export interface PsiCell {
  lat: number;
  lng: number;
  psi: number | null;
}

export interface RichnessCell {
  lat: number;
  lng: number;
  richness: number;
  nSpecies: number;
}

export function sumRichness(grids: PsiCell[][], precision = 5): RichnessCell[] {
  const acc = new Map<string, { lat: number; lng: number; richness: number; nSpecies: number }>();
  for (const grid of grids) {
    for (const c of grid) {
      if (c.psi == null || !Number.isFinite(c.psi)) continue;
      const key = `${c.lat.toFixed(precision)},${c.lng.toFixed(precision)}`;
      const cur = acc.get(key);
      if (cur) {
        cur.richness += c.psi;
        cur.nSpecies += 1;
      } else {
        acc.set(key, { lat: c.lat, lng: c.lng, richness: c.psi, nSpecies: 1 });
      }
    }
  }
  return [...acc.values()];
}
