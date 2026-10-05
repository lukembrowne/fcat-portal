/**
 * "Sugeridos por revisores": clips reviewers attributed to this species while
 * validating another one.
 *
 * A Server Component that resolves every name before handing the client table
 * plain strings — `resolveDisplayName` and `reviewerLabel` are plain modules,
 * but resolving here keeps the client payload to what is rendered.
 *
 * These clips are never part of this species' sample. The section says so in
 * its hint, and the data comes from `getSpeciesSuggestions`, which no fit,
 * coverage or total reads.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { speciesSlug } from "@/lib/species-slug";
import type { SpeciesSuggestion } from "@/app/audio/validacion/actions";
import {
  SUGGESTIONS_HINT,
  SUGGESTIONS_TITLE,
  hiddenSuggestionsNote,
} from "@/app/audio/validacion/labels";
import { resolveDisplayName, type NameLang } from "@/app/audio/validacion/name-language";

import { reviewerLabel } from "./reviewer-label";
import { SuggestionsTable, type SuggestionRow } from "./suggestions-table";

export function SuggestionsSection({
  suggestions,
  hidden = 0,
  nameLang,
  error,
  showEmpty = false,
}: {
  suggestions: SpeciesSuggestion[];
  /**
   * Suggestions withheld by `getSpeciesSuggestions`' blinding rule — only the
   * count ever reaches this component.
   */
  hidden?: number;
  nameLang: NameLang;
  error?: string | null;
  /** Render the card even with nothing in it (the suggestions-only page). */
  showEmpty?: boolean;
}) {
  if (!error && suggestions.length === 0 && hidden === 0 && !showEmpty) return null;

  const rows: SuggestionRow[] = suggestions.map((s) => ({
    reviewId: s.reviewId,
    sampleId: s.sampleId,
    sourceSpecies: s.sourceSpecies,
    sourceDisplayName: resolveDisplayName(
      {
        scientificName: s.sourceSpecies,
        commonName: s.sourceCommonName,
        spanishName: s.sourceSpanishName,
      },
      nameLang
    ),
    sourceSlug: speciesSlug(s.sourceSpecies),
    siteName: s.siteName,
    recordedAt: s.recordedAt,
    reviewerLabel: reviewerLabel({ email: s.reviewerEmail, name: s.reviewerName }),
    reviewerEmail: s.reviewerEmail,
    reviewedAt: s.reviewedAt,
  }));
  const clips = new Set(suggestions.map((s) => s.sampleId)).size;
  const hiddenNote = hiddenSuggestionsNote(hidden, rows.length);

  return (
    <Card id="sugeridos" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>{SUGGESTIONS_TITLE}</CardTitle>
        <p className="text-sm text-muted-foreground">{SUGGESTIONS_HINT}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {error ? (
          <p className="rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-900">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {hiddenNote ?? "Ningún revisor ha atribuido clips a esta especie."}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              <strong className="tabular-nums">{clips}</strong>{" "}
              {clips === 1 ? "clip" : "clips"}
              {rows.length > clips ? (
                <>
                  {" "}
                  · <strong className="tabular-nums">{rows.length}</strong>{" "}
                  sugerencias (cada revisor cuenta por separado)
                </>
              ) : null}
            </p>
            <SuggestionsTable rows={rows} />
            {hiddenNote ? (
              <p className="text-xs text-muted-foreground">{hiddenNote}</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
