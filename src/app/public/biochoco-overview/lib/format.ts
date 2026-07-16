/**
 * Pure formatting helpers shared by the report shell and the download export.
 * Kept out of the client component so they can be unit-tested in the repo's
 * node test environment.
 */

import type { Lang } from "./snapshot-types";

export function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Interpolate `{token}` placeholders; unknown tokens are left intact. */
export function tpl(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** "Jan 2026 – Jul 2026" style span from ISO start/end. Empty parts are dropped. */
export function spanLabel(start: string | null, end: string | null, lang: Lang): string {
  const mo = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(lang === "es" ? "es-EC" : "en-US", {
      month: "short",
      year: "numeric",
    });
  };
  return [mo(start), mo(end)].filter(Boolean).join(" – ");
}
