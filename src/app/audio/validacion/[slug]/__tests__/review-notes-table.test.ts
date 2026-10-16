import { describe, expect, it } from "vitest";

import {
  filterReviewNotes,
  sortReviewNotes,
  type ReviewNoteRow,
} from "../review-notes-table";

function row(over: Partial<ReviewNoteRow> & { reviewId: number }): ReviewNoteRow {
  return {
    sampleId: over.reviewId,
    note: "canto",
    outcome: "correct",
    siteName: "CCN-003",
    recordedAt: "2026-01-30 06:00:12",
    reviewerLabel: "Maia",
    reviewerEmail: "maia@x.org",
    ...over,
  };
}

const ROWS = [
  row({ reviewId: 3, note: "Canto con trino" }),
  row({ reviewId: 1, note: "alarma", siteName: null }),
  row({ reviewId: 2, note: "alarma", reviewerLabel: "Juan" }),
];

describe("sortReviewNotes", () => {
  it("groups identical labels, case-insensitively, with an id tiebreak", () => {
    expect(sortReviewNotes(ROWS, "note", "asc").map((r) => r.reviewId)).toEqual([1, 2, 3]);
    expect(sortReviewNotes(ROWS, "note", "desc").map((r) => r.reviewId)).toEqual([3, 1, 2]);
  });

  it("puts a missing site last in both directions", () => {
    expect(sortReviewNotes(ROWS, "site", "asc").at(-1)!.reviewId).toBe(1);
    expect(sortReviewNotes(ROWS, "site", "desc").at(-1)!.reviewId).toBe(1);
  });
});

describe("filterReviewNotes", () => {
  it("matches note text and reviewer, ignoring case and accents", () => {
    const rows = [row({ reviewId: 1, note: "Llamada de alarma" }), row({ reviewId: 2 })];
    expect(filterReviewNotes(rows, "ALARMA").map((r) => r.reviewId)).toEqual([1]);
    expect(filterReviewNotes([row({ reviewId: 1, note: "canción" })], "cancion")).toHaveLength(1);
    expect(filterReviewNotes(ROWS, "juan").map((r) => r.reviewId)).toEqual([2]);
    expect(filterReviewNotes(ROWS, "  ")).toHaveLength(3);
  });
});
