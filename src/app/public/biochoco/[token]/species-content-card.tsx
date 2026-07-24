/**
 * Public finca-page species content card (fallback per-species page).
 *
 * Renders the shared, admin-authored context for a species — its role in the
 * forest and any optional management tip, one free-text field authored in
 * /biochoco/fichas-especies and propagated to every finca page. Renders nothing
 * when empty. Formatting is plain text via the shared FormatSpeciesContent
 * helper (paragraphs + bullets, React-escaped — no markdown, no injection).
 *
 * Server Component (no interactivity).
 */

import { Sprout } from "lucide-react";
import { FormatSpeciesContent } from "@/lib/landowner/format-species-content";

interface SpeciesContentCardProps {
  publicContent: string | null;
}

export function SpeciesContentCard({ publicContent }: SpeciesContentCardProps) {
  const content = publicContent?.trim();
  if (!content) return null;

  return (
    <section className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/30">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-emerald-900 dark:text-emerald-200">
        <Sprout className="h-4 w-4 shrink-0" aria-hidden />
        Sobre esta especie
      </h2>
      <div className="space-y-2 text-sm text-emerald-950/90 dark:text-emerald-100/90">
        <FormatSpeciesContent text={content} />
      </div>
    </section>
  );
}
