/**
 * Shared formatting + styling helpers for the portal's HTML emails.
 *
 * Used by both nightly cron emails:
 *  - /api/cron/nightly-refresh  ("BioChoco Datos — Resumen nocturno")
 *  - /api/cron/portal-updates   ("Actividad del Portal")
 *
 * Pure functions only (no `server-only`, no DB) so they stay unit-testable.
 */

// ---------------------------------------------------------------------------
// Shared table styling — keep both emails visually consistent
// ---------------------------------------------------------------------------

export const TABLE_HEADER_BG = "#f3f4f6";
export const TABLE_BORDER = "#e5e7eb";
export const COLOR_POSITIVE = "#16a34a";
export const COLOR_NEGATIVE = "#dc2626";
export const COLOR_MUTED = "#6b7280";

// ---------------------------------------------------------------------------
// Numbers, bytes, durations
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

/**
 * Human-readable job duration in Spanish.
 * - null/negative → "—"
 * - < 60s         → "42 s"
 * - < 60min       → "4 min 12 s"
 * - otherwise     → "1 h 6 min"
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${totalMinutes} min ${seconds} s` : `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}

// ---------------------------------------------------------------------------
// Dates (UTC, ISO-derived — matches existing email conventions)
// ---------------------------------------------------------------------------

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function formatDateTime(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Delta rendering (green/red change indicators vs a previous snapshot)
// ---------------------------------------------------------------------------

/**
 * Render a count cell with an inline delta vs the previous run.
 * - previous === null: first run, show count only.
 * - delta === 0: show count only (avoid noise on stable deployments).
 * - delta !== 0: show "<count> <span>(+N)</span>" with color.
 */
export function formatCountCell(
  current: number | null | undefined,
  previous: number | null,
): string {
  const cur = current ?? 0;
  if (previous === null) return cur.toLocaleString();
  const d = cur - previous;
  if (d === 0) return cur.toLocaleString();
  const color = d > 0 ? COLOR_POSITIVE : COLOR_NEGATIVE;
  const sign = d > 0 ? "+" : "";
  return `${cur.toLocaleString()} <span style="color:${color};font-weight:600;font-size:11px">(${sign}${d})</span>`;
}

export function formatDeltaHtml(
  countDelta: number | null,
  sizeDelta: number | null,
  previousDate: string | null,
): string {
  if (countDelta === null) return "";
  const sinceLabel = previousDate ? `desde ${previousDate}` : "desde último conteo";
  if (countDelta === 0 && (sizeDelta === null || sizeDelta === 0)) {
    return ` <span style="color:${COLOR_MUTED}">sin cambios ${sinceLabel}</span>`;
  }
  const parts: string[] = [];
  if (countDelta !== 0) {
    parts.push(`${countDelta > 0 ? "+" : ""}${countDelta} archivos`);
  }
  if (sizeDelta && sizeDelta !== 0) {
    parts.push(`${sizeDelta > 0 ? "+" : ""}${formatBytes(Math.abs(sizeDelta))}`);
  }
  const color = countDelta > 0 ? COLOR_POSITIVE : COLOR_NEGATIVE;
  return ` <span style="color:${color};font-weight:600">${parts.join(", ")} ${sinceLabel}</span>`;
}

export function formatNewSince(
  value: number | null,
  previousDate: string | null,
): string {
  if (value === null) return "";
  const sinceLabel = previousDate ? `desde ${previousDate}` : "desde último conteo";
  if (value === 0) {
    return ` <span style="color:${COLOR_MUTED}">sin cambios ${sinceLabel}</span>`;
  }
  const color = value > 0 ? COLOR_POSITIVE : COLOR_NEGATIVE;
  return ` <span style="color:${color};font-weight:600">+${value.toLocaleString()} ${sinceLabel}</span>`;
}
