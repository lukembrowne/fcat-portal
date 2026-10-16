/**
 * "Notas de revisión": every reviewer's per-clip notes on this species' sample.
 *
 * Server Component, like `SuggestionsSection`: reviewer names are resolved here
 * so the client table receives plain strings. The rows come from
 * `getReviewNotes`, already blinded — only the withheld COUNT reaches here.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReviewNote } from "@/app/audio/validacion/actions";
import {
  REVIEW_NOTES_HINT,
  REVIEW_NOTES_TITLE,
  hiddenReviewNotesNote,
} from "@/app/audio/validacion/labels";

import { reviewerLabel } from "./reviewer-label";
import { ReviewNotesTable, type ReviewNoteRow } from "./review-notes-table";

export function ReviewNotesSection({
  notes,
  hidden = 0,
  error,
}: {
  notes: ReviewNote[];
  hidden?: number;
  error?: string | null;
}) {
  // Nothing to say on a species nobody has annotated: no empty card.
  if (!error && notes.length === 0 && hidden === 0) return null;

  const rows: ReviewNoteRow[] = notes.map((n) => ({
    reviewId: n.reviewId,
    sampleId: n.sampleId,
    note: n.note,
    outcome: n.outcome,
    siteName: n.siteName,
    recordedAt: n.recordedAt,
    reviewerLabel: reviewerLabel({ email: n.reviewerEmail, name: n.reviewerName }),
    reviewerEmail: n.reviewerEmail,
  }));
  const clips = new Set(notes.map((n) => n.sampleId)).size;
  const hiddenNote = hiddenReviewNotesNote(hidden, rows.length);

  return (
    <Card id="notas" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>{REVIEW_NOTES_TITLE}</CardTitle>
        <p className="text-sm text-muted-foreground">{REVIEW_NOTES_HINT}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {error ? (
          <p className="rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-900">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{hiddenNote}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              <strong className="tabular-nums">{rows.length}</strong>{" "}
              {rows.length === 1 ? "nota" : "notas"} en{" "}
              <strong className="tabular-nums">{clips}</strong>{" "}
              {clips === 1 ? "clip" : "clips"}
            </p>
            <ReviewNotesTable rows={rows} />
            {hiddenNote ? (
              <p className="text-xs text-muted-foreground">{hiddenNote}</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
