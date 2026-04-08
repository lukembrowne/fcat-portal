import { describe, it, expect } from "vitest";
import {
  speciesSlug,
  assignSplit,
  computeContentHash,
  buildCounts,
  type HashRow,
} from "@/lib/training-export-helpers";

describe("speciesSlug", () => {
  it("lowercases and joins with underscore", () => {
    expect(speciesSlug("Leopardus pardalis")).toBe("leopardus_pardalis");
  });

  it("strips diacritics", () => {
    expect(speciesSlug("Tinamú café")).toBe("tinamu_cafe");
    expect(speciesSlug("Yaguarundí")).toBe("yaguarundi");
  });

  it("collapses hyphens, slashes, and runs of punctuation", () => {
    expect(speciesSlug("Puma-yagouaroundi")).toBe("puma_yagouaroundi");
    expect(speciesSlug("Tapirus / bairdii")).toBe("tapirus_bairdii");
    expect(speciesSlug("Genus,, ,species")).toBe("genus_species");
  });

  it("trims leading and trailing junk", () => {
    expect(speciesSlug("  Mazama americana  ")).toBe("mazama_americana");
    expect(speciesSlug("---ocelot---")).toBe("ocelot");
  });

  it("handles empty-ish input", () => {
    expect(speciesSlug("")).toBe("");
    expect(speciesSlug("   ")).toBe("");
    expect(speciesSlug("---")).toBe("");
  });
});

describe("assignSplit", () => {
  it("is deterministic for the same id", () => {
    expect(assignSplit(42)).toBe(assignSplit(42));
    expect(assignSplit(9999)).toBe(assignSplit(9999));
  });

  it("only ever returns train, val, or test", () => {
    for (let i = 0; i < 200; i++) {
      expect(["train", "val", "test"]).toContain(assignSplit(i));
    }
  });

  it("distributes roughly 70/15/15 over 1000 ids", () => {
    const counts = { train: 0, val: 0, test: 0 } as Record<string, number>;
    for (let i = 1; i <= 1000; i++) counts[assignSplit(i)] += 1;
    // Generous tolerances — we just want to catch a totally broken bucket.
    expect(counts.train).toBeGreaterThan(620);
    expect(counts.train).toBeLessThan(780);
    expect(counts.val).toBeGreaterThan(100);
    expect(counts.val).toBeLessThan(200);
    expect(counts.test).toBeGreaterThan(100);
    expect(counts.test).toBeLessThan(200);
  });
});

describe("computeContentHash", () => {
  const baseRows: HashRow[] = [
    { imageId: 1, finalLabel: "ocelot", deploymentId: 10, split: "train" },
    { imageId: 2, finalLabel: "puma", deploymentId: 10, split: "train" },
    { imageId: 3, finalLabel: "ocelot", deploymentId: 11, split: "val" },
  ];
  const baseInput = {
    rows: baseRows,
    minExamples: 50,
    classList: ["ocelot", "puma"],
  };

  it("is deterministic across 10 runs on identical input", () => {
    const first = computeContentHash(baseInput);
    for (let i = 0; i < 10; i++) {
      expect(computeContentHash(baseInput)).toBe(first);
    }
  });

  it("is independent of row insertion order", () => {
    const reordered = {
      ...baseInput,
      rows: [...baseRows].reverse(),
    };
    expect(computeContentHash(reordered)).toBe(computeContentHash(baseInput));
  });

  it("is independent of class-list order", () => {
    const reordered = {
      ...baseInput,
      classList: ["puma", "ocelot"],
    };
    expect(computeContentHash(reordered)).toBe(computeContentHash(baseInput));
  });

  it("changes when minExamples changes", () => {
    expect(computeContentHash({ ...baseInput, minExamples: 51 })).not.toBe(
      computeContentHash(baseInput),
    );
  });

  it("changes when a label changes", () => {
    const mutated: HashRow[] = [
      { ...baseRows[0], finalLabel: "ocelot_corrected" },
      ...baseRows.slice(1),
    ];
    expect(computeContentHash({ ...baseInput, rows: mutated })).not.toBe(
      computeContentHash(baseInput),
    );
  });

  it("rejects label-collision via pipe characters", () => {
    // A naive `rows.map(r => r.join('|')).join('\n')` would let
    // 'a|b' + 'c' collide with 'a' + 'b|c'. JSON serialization
    // prevents this — assert the two scenarios produce distinct hashes.
    const a: HashRow[] = [
      { imageId: 1, finalLabel: "a|b", deploymentId: 1, split: "train" },
      { imageId: 2, finalLabel: "c", deploymentId: 1, split: "train" },
    ];
    const b: HashRow[] = [
      { imageId: 1, finalLabel: "a", deploymentId: 1, split: "train" },
      { imageId: 2, finalLabel: "b|c", deploymentId: 1, split: "train" },
    ];
    expect(
      computeContentHash({ rows: a, minExamples: 1, classList: ["a|b", "c"] }),
    ).not.toBe(
      computeContentHash({ rows: b, minExamples: 1, classList: ["a", "b|c"] }),
    );
  });
});

describe("buildCounts", () => {
  it("aggregates per-split and per-class counts", () => {
    const counts = buildCounts([
      { finalLabel: "Ocelot", split: "train" },
      { finalLabel: "Ocelot", split: "train" },
      { finalLabel: "Ocelot", split: "val" },
      { finalLabel: "Puma", split: "train" },
      { finalLabel: "Puma", split: "test" },
    ]);
    expect(counts.total).toBe(5);
    expect(counts.train).toBe(3);
    expect(counts.val).toBe(1);
    expect(counts.test).toBe(1);
    expect(counts.perClass.ocelot).toEqual({ train: 2, val: 1, test: 0 });
    expect(counts.perClass.puma).toEqual({ train: 1, val: 0, test: 1 });
  });
});
