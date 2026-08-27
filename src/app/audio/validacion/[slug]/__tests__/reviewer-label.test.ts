/**
 * Pure display helpers for the reviewer roster. The component itself is a thin
 * shell around these, so they carry the logic worth asserting on.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { formatReviewerProgress, reviewerLabel } from "../reviewer-label";

describe("reviewerLabel", () => {
  it("prefers the portal name", () => {
    expect(reviewerLabel({ email: "juan@fcat.org", name: "Juan Freile" })).toBe(
      "Juan Freile"
    );
  });

  it("falls back to the email when there is no users row", () => {
    // External reviewers may have no portal account yet.
    expect(reviewerLabel({ email: "juan@fcat.org", name: null })).toBe("juan@fcat.org");
  });

  it("treats a blank name as missing", () => {
    expect(reviewerLabel({ email: "juan@fcat.org", name: "   " })).toBe("juan@fcat.org");
  });
});

describe("formatReviewerProgress", () => {
  it("reports count and percentage", () => {
    expect(formatReviewerProgress(45, 200)).toBe("45 / 200 (23%)");
  });

  it("renders a rostered reviewer who has not started as zero, not blank", () => {
    expect(formatReviewerProgress(0, 200)).toBe("0 / 200 (0%)");
  });

  it("reports completion", () => {
    expect(formatReviewerProgress(200, 200)).toBe("200 / 200 (100%)");
  });

  it("avoids dividing by zero before a sample is drawn", () => {
    expect(formatReviewerProgress(0, 0)).toBe("sin muestra");
  });
});

/**
 * The reason this module exists at all.
 *
 * `reviewerLabel` used to live in `reviewer-roster.tsx`, which is a
 * `"use client"` module. `AgreementPanel` renders on the server and called it,
 * which throws "Attempted to call reviewerLabel() from the server" and takes
 * the whole species page down with it — but only once a primary reviewer is
 * designated AND a second person has co-reviewed clips, which is the only time
 * the agreement table draws a row. Nothing in types or `npm run build` catches
 * it; it is a runtime boundary error.
 */
describe("module boundary", () => {
  it("has no 'use client' directive, so the server may call it", () => {
    const source = readFileSync(
      new URL("../reviewer-label.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/^\s*["']use client["']/);
  });
});
