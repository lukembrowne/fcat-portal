/**
 * Pure display helpers for the reviewer roster. The component itself is a thin
 * shell around these, so they carry the logic worth asserting on.
 */

import { describe, expect, it } from "vitest";
import { formatReviewerProgress, reviewerLabel } from "../reviewer-roster";

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
