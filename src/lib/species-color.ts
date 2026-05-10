export const COLOR_PALETTE = [
  "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7",
  "#06b6d4", "#f97316", "#ec4899", "#14b8a6", "#8b5cf6",
];

export const DEFAULT_SPECIES_COLOR = "#22c55e";

const SPECIES_COLORS: Record<string, string> = {};

export function getSpeciesColor(species: string | null | undefined): string {
  if (!species) return DEFAULT_SPECIES_COLOR;
  if (!SPECIES_COLORS[species]) {
    const idx = Object.keys(SPECIES_COLORS).length % COLOR_PALETTE.length;
    SPECIES_COLORS[species] = COLOR_PALETTE[idx];
  }
  return SPECIES_COLORS[species];
}

export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
