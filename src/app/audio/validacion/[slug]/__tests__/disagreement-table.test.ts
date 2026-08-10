/**
 * Pure sort for the disagreement browser.
 *
 * Ordering carries meaning here: high-confidence disagreements are the ones a
 * threshold would retain, so they lead by default.
 */

import { describe, expect, it } from "vitest";
import type { Disagreement } from "@/app/audio/validacion/actions";
import { sortDisagreements } from "../desacuerdos/disagreement-table";

function row(overrides: Partial<Disagreement> & { sampleId: number }): Disagreement {
  return {
    audioIdentificationId: overrides.sampleId * 10,
    confidence: 0.5,
    binIndex: 4,
    siteName: null,
    habitat: null,
    answers: [],
    ...overrides,
  };
}

const ROWS: Disagreement[] = [
  row({ sampleId: 1, confidence: 0.42, siteName: "CCN-010", habitat: "bosque" }),
  row({
    sampleId: 2,
    confidence: 0.91,
    siteName: "AAA-001",
    habitat: "cacao",
    answers: [
      { email: "a@x.org", name: null, outcome: "correct" },
      { email: "b@x.org", name: null, outcome: "incorrect" },
      { email: "c@x.org", name: null, outcome: "uncertain" },
    ],
  }),
  row({ sampleId: 3, confidence: 0.42, siteName: "BBB-002", habitat: "pasto" }),
];

describe("sortDisagreements", () => {
  it("orders by confidence descending", () => {
    const sorted = sortDisagreements(ROWS, "confidence", "desc");
    expect(sorted.map((r) => r.sampleId)).toEqual([2, 1, 3]);
  });

  it("orders by confidence ascending", () => {
    const sorted = sortDisagreements(ROWS, "confidence", "asc");
    expect(sorted[sorted.length - 1].sampleId).toBe(2);
  });

  it("breaks confidence ties on sampleId so order is stable", () => {
    // Rows 1 and 3 both sit at 0.42.
    expect(sortDisagreements(ROWS, "confidence", "desc").slice(1).map((r) => r.sampleId))
      .toEqual([1, 3]);
    expect(sortDisagreements(ROWS, "confidence", "asc").slice(0, 2).map((r) => r.sampleId))
      .toEqual([1, 3]);
  });

  it("orders by site name in both directions", () => {
    expect(sortDisagreements(ROWS, "site", "asc").map((r) => r.siteName)).toEqual([
      "AAA-001",
      "BBB-002",
      "CCN-010",
    ]);
    expect(sortDisagreements(ROWS, "site", "desc").map((r) => r.siteName)).toEqual([
      "CCN-010",
      "BBB-002",
      "AAA-001",
    ]);
  });

  it("orders by habitat", () => {
    expect(sortDisagreements(ROWS, "habitat", "asc").map((r) => r.habitat)).toEqual([
      "bosque",
      "cacao",
      "pasto",
    ]);
  });

  it("orders by answer count", () => {
    expect(sortDisagreements(ROWS, "answers", "desc")[0].sampleId).toBe(2);
  });

  it("does not mutate the input array", () => {
    const original = [...ROWS];
    sortDisagreements(ROWS, "site", "asc");
    expect(ROWS).toEqual(original);
  });

  it("handles null site and habitat without throwing", () => {
    const withNulls = [row({ sampleId: 9 }), ...ROWS];
    expect(() => sortDisagreements(withNulls, "site", "asc")).not.toThrow();
    expect(sortDisagreements(withNulls, "habitat", "asc")).toHaveLength(4);
  });
});
