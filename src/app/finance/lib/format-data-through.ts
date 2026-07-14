/**
 * Format the "data current through" caption shown on the Ingresos/Gastos pages.
 * Input is the latest transaction date (YYYY-MM-DD) from the Libro Mayor, or null.
 */

const MONTHS_ES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

export function formatDataThrough(dataThrough: string | null): string {
  if (!dataThrough) {
    return "Sin datos del Libro Mayor en este período";
  }
  const parts = dataThrough.split("-");
  if (parts.length !== 3) {
    return `Datos actualizados hasta el ${dataThrough} · Libro Mayor`;
  }
  const [y, m, d] = parts;
  const monthIdx = parseInt(m, 10) - 1;
  const monthName = MONTHS_ES[monthIdx] ?? m;
  return `Datos actualizados hasta el ${parseInt(d, 10)} ${monthName} ${y} · Libro Mayor`;
}
