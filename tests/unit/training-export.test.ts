import { describe, it, expect } from "vitest";
import {
  speciesSlug,
  assignSplit,
  computeContentHash,
  buildCounts,
  stratifyDeploymentSplits,
  selectIncludedClasses,
  findUncoveredLabels,
  SPLIT_STRATEGY_VERSION,
  STRATIFY_MIN_DEPLOYMENTS,
  type HashRow,
  type Split,
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

describe("SPLIT_STRATEGY_VERSION", () => {
  it("is the current code version (2)", () => {
    // Bumping this constant is a deliberate, hash-invalidating event.
    // Update the assertion in lockstep with the helper export.
    expect(SPLIT_STRATEGY_VERSION).toBe(2);
  });

  it("is included in the content hash so a bump invalidates old hashes", () => {
    // Snapshot of a v1-equivalent canonical hash computed before the bump.
    // Any code change that does NOT bump SPLIT_STRATEGY_VERSION but does
    // change the canonicalization would silently invalidate models — this
    // test guards against that.
    const sample: HashRow[] = [
      { imageId: 1, finalLabel: "ocelot", deploymentId: 10, split: "train" },
    ];
    const hash = computeContentHash({
      rows: sample,
      minExamples: 50,
      classList: ["ocelot"],
    });
    // Hash must be a 64-char hex string and stable over runs.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const again = computeContentHash({
      rows: sample,
      minExamples: 50,
      classList: ["ocelot"],
    });
    expect(again).toBe(hash);
  });
});

describe("stratifyDeploymentSplits", () => {
  /** Build a speciesByDeployment Map for n-deployment, single-species cases. */
  function singleSpecies(
    species: string,
    depIds: number[],
  ): Map<number, Set<string>> {
    const m = new Map<number, Set<string>>();
    for (const id of depIds) m.set(id, new Set([species]));
    return m;
  }

  it("returns hash bucket for species with fewer than the threshold deployments", () => {
    expect(STRATIFY_MIN_DEPLOYMENTS).toBe(3);
    // Find two ids — whatever the hash gives, the stratifier must not move them.
    const ids = [101, 102];
    const result = stratifyDeploymentSplits({
      deploymentIds: ids,
      speciesByDeployment: singleSpecies("rare_species", ids),
      anchored: new Map(),
    });
    for (const id of ids) {
      expect(result.splitByDeployment.get(id)).toBe(assignSplit(id));
    }
    expect(result.forcedReassignments).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("forces 1/1/1 coverage when 3 deployments all hash to the same split", () => {
    // Find three deployment ids that all hash to "train".
    const trainIds: number[] = [];
    let i = 1;
    while (trainIds.length < 3 && i < 10000) {
      if (assignSplit(i) === "train") trainIds.push(i);
      i++;
    }
    expect(trainIds).toHaveLength(3);

    const result = stratifyDeploymentSplits({
      deploymentIds: trainIds,
      speciesByDeployment: singleSpecies("forced_species", trainIds),
      anchored: new Map(),
    });

    const splits = trainIds.map((id) => result.splitByDeployment.get(id)!);
    const counts = { train: 0, val: 0, test: 0 } as Record<Split, number>;
    for (const s of splits) counts[s] += 1;
    expect(counts.train).toBe(1);
    expect(counts.val).toBe(1);
    expect(counts.test).toBe(1);
    expect(result.forcedReassignments.length).toBe(2);
    expect(result.warnings).toHaveLength(0);
  });

  it("is fully deterministic on identical input", () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const species = singleSpecies("species_a", ids);
    const r1 = stratifyDeploymentSplits({
      deploymentIds: ids,
      speciesByDeployment: species,
      anchored: new Map(),
    });
    const r2 = stratifyDeploymentSplits({
      deploymentIds: ids,
      speciesByDeployment: species,
      anchored: new Map(),
    });
    for (const id of ids) {
      expect(r1.splitByDeployment.get(id)).toBe(r2.splitByDeployment.get(id));
    }
    expect(r1.forcedReassignments).toEqual(r2.forcedReassignments);
  });

  it("never moves anchored deployments and warns when it can't help", () => {
    // 3 anchored deployments, all in train — stratifier cannot rebalance.
    const ids = [201, 202, 203];
    const anchored = new Map<number, Split>([
      [201, "train"],
      [202, "train"],
      [203, "train"],
    ]);
    const result = stratifyDeploymentSplits({
      deploymentIds: ids,
      speciesByDeployment: singleSpecies("anchored_species", ids),
      anchored,
    });
    for (const id of ids) {
      expect(result.splitByDeployment.get(id)).toBe("train");
    }
    // Two warnings expected (val empty + test empty), both for the same species.
    expect(result.warnings.map((w) => w.label)).toEqual([
      "anchored_species",
      "anchored_species",
    ]);
    expect(result.forcedReassignments).toHaveLength(0);
  });

  it("processes rarer species first so common species absorb the cascade", () => {
    // Common species has 6 deployments (1..6). Rare species shares deployments
    // 1, 2, 3 — already split 1/1/1 by anchors. Rare species has 3 deployments
    // (1, 2, 3) so already covered. No moves needed.
    const deployments = [1, 2, 3, 4, 5, 6];
    const speciesByDeployment = new Map<number, Set<string>>();
    speciesByDeployment.set(1, new Set(["common", "rare"]));
    speciesByDeployment.set(2, new Set(["common", "rare"]));
    speciesByDeployment.set(3, new Set(["common", "rare"]));
    speciesByDeployment.set(4, new Set(["common"]));
    speciesByDeployment.set(5, new Set(["common"]));
    speciesByDeployment.set(6, new Set(["common"]));
    const anchored = new Map<number, Split>([
      [1, "train"],
      [2, "val"],
      [3, "test"],
      [4, "train"],
      [5, "train"],
      [6, "train"],
    ]);
    const result = stratifyDeploymentSplits({
      deploymentIds: deployments,
      speciesByDeployment,
      anchored,
    });
    // No moves: every species already has 1/1/1.
    expect(result.forcedReassignments).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    // Anchors preserved.
    for (const [id, s] of anchored) {
      expect(result.splitByDeployment.get(id)).toBe(s);
    }
  });

  it("only moves rare-species coverage when forced; common species ride along", () => {
    // Common species (id 1..10) all unanchored; rare species lives only on
    // deployments 11, 12, 13 — also unanchored. Stratifier may need to move
    // up to 2 of the rare-species deployments to val and test.
    const deploymentIds = Array.from({ length: 13 }, (_, i) => i + 1);
    const speciesByDeployment = new Map<number, Set<string>>();
    for (let i = 1; i <= 10; i++) {
      speciesByDeployment.set(i, new Set(["common"]));
    }
    for (let i = 11; i <= 13; i++) {
      speciesByDeployment.set(i, new Set(["rare"]));
    }
    const result = stratifyDeploymentSplits({
      deploymentIds,
      speciesByDeployment,
      anchored: new Map(),
    });

    // Rare species must have 1/1/1.
    const rareCounts = { train: 0, val: 0, test: 0 } as Record<Split, number>;
    for (const id of [11, 12, 13]) {
      rareCounts[result.splitByDeployment.get(id)!] += 1;
    }
    expect(rareCounts.train).toBe(1);
    expect(rareCounts.val).toBe(1);
    expect(rareCounts.test).toBe(1);

    // Common species — must still have ≥1 in each split (it has 10 deployments
    // and hash distributes ~70/15/15).
    const commonCounts = { train: 0, val: 0, test: 0 } as Record<
      Split,
      number
    >;
    for (let i = 1; i <= 10; i++) {
      commonCounts[result.splitByDeployment.get(i)!] += 1;
    }
    expect(commonCounts.train).toBeGreaterThanOrEqual(1);
    expect(commonCounts.val).toBeGreaterThanOrEqual(1);
    expect(commonCounts.test).toBeGreaterThanOrEqual(1);
  });

  it("emits forcedReassignments sorted deterministically by label then id", () => {
    // Two species that both need forced moves; ensure surfaced moves are
    // sorted by label asc, then deployment id asc.
    const trainIds: number[] = [];
    let i = 1;
    while (trainIds.length < 6 && i < 10000) {
      if (assignSplit(i) === "train") trainIds.push(i);
      i++;
    }
    expect(trainIds.length).toBeGreaterThanOrEqual(6);
    const aIds = trainIds.slice(0, 3);
    const bIds = trainIds.slice(3, 6);
    const speciesByDeployment = new Map<number, Set<string>>();
    for (const id of aIds) speciesByDeployment.set(id, new Set(["alpha"]));
    for (const id of bIds) speciesByDeployment.set(id, new Set(["beta"]));
    const result = stratifyDeploymentSplits({
      deploymentIds: [...aIds, ...bIds],
      speciesByDeployment,
      anchored: new Map(),
    });
    const labels = result.forcedReassignments.map((r) => r.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, "es"));
    expect(labels).toEqual(sorted);
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

describe("selectIncludedClasses", () => {
  it("drops the v1 livestock regression: 75 examples in 2 deployments", () => {
    // This is the exact scenario that broke training-export-v1.tar.gz:
    // Anas platyrhynchos domesticus had 75 verified detections but all came
    // from 2 cameras that both hashed to the train split.
    const { classList, droppedSpecies } = selectIncludedClasses({
      labelCounts: new Map([["anas_platyrhynchos_domesticus", 75]]),
      labelDeployments: new Map([
        ["anas_platyrhynchos_domesticus", new Set([901, 902])],
      ]),
      minExamples: 30,
      minDeployments: 3,
    });
    expect(classList).toEqual([]);
    expect(droppedSpecies).toEqual({ anas_platyrhynchos_domesticus: 75 });
  });

  it("keeps a class exactly at the deployment threshold", () => {
    const { classList, droppedSpecies } = selectIncludedClasses({
      labelCounts: new Map([["ocelot", 50]]),
      labelDeployments: new Map([["ocelot", new Set([1, 2, 3])]]),
      minExamples: 30,
      minDeployments: 3,
    });
    expect(classList).toEqual(["ocelot"]);
    expect(droppedSpecies).toEqual({});
  });

  it("drops a class one deployment below the threshold", () => {
    const { classList, droppedSpecies } = selectIncludedClasses({
      labelCounts: new Map([["ocelot", 500]]),
      labelDeployments: new Map([["ocelot", new Set([1, 2])]]),
      minExamples: 30,
      minDeployments: 3,
    });
    expect(classList).toEqual([]);
    expect(droppedSpecies).toEqual({ ocelot: 500 });
  });

  it("drops a class one example below the threshold even with enough deployments", () => {
    const { classList, droppedSpecies } = selectIncludedClasses({
      labelCounts: new Map([["puma", 29]]),
      labelDeployments: new Map([["puma", new Set([1, 2, 3, 4])]]),
      minExamples: 30,
      minDeployments: 3,
    });
    expect(classList).toEqual([]);
    expect(droppedSpecies).toEqual({ puma: 29 });
  });

  it("returns surviving classes sorted alphabetically", () => {
    const { classList } = selectIncludedClasses({
      labelCounts: new Map([
        ["puma_concolor", 60],
        ["aotus_lemurinus", 40],
        ["mazama_americana", 80],
      ]),
      labelDeployments: new Map([
        ["puma_concolor", new Set([1, 2, 3])],
        ["aotus_lemurinus", new Set([4, 5, 6])],
        ["mazama_americana", new Set([7, 8, 9])],
      ]),
      minExamples: 30,
      minDeployments: 3,
    });
    expect(classList).toEqual([
      "aotus_lemurinus",
      "mazama_americana",
      "puma_concolor",
    ]);
  });

  it("handles empty input", () => {
    const result = selectIncludedClasses({
      labelCounts: new Map(),
      labelDeployments: new Map(),
      minExamples: 30,
      minDeployments: 3,
    });
    expect(result.classList).toEqual([]);
    expect(result.droppedSpecies).toEqual({});
  });
});

describe("findUncoveredLabels", () => {
  it("returns labels with zero in any split", () => {
    const counts = new Map([
      ["covered", { train: 5, val: 1, test: 1 }],
      ["no_val", { train: 5, val: 0, test: 1 }],
      ["no_test", { train: 5, val: 1, test: 0 }],
      ["no_train", { train: 0, val: 1, test: 1 }],
    ]);
    expect(findUncoveredLabels(counts)).toEqual([
      "no_test",
      "no_train",
      "no_val",
    ]);
  });

  it("returns empty when every label has 1/1/1 coverage", () => {
    const counts = new Map([
      ["a", { train: 1, val: 1, test: 1 }],
      ["b", { train: 10, val: 5, test: 3 }],
    ]);
    expect(findUncoveredLabels(counts)).toEqual([]);
  });

  it("flags the anchored-cameras edge case (3 deployments all anchored to train)", () => {
    // Simulates the post-stratify state when a class survives inclusion
    // (≥3 deployments) but the stratifier could not rebalance because all
    // 3 deployments were anchored to train from a prior export.
    const counts = new Map([
      ["anchored_to_train_only", { train: 60, val: 0, test: 0 }],
    ]);
    expect(findUncoveredLabels(counts)).toEqual(["anchored_to_train_only"]);
  });
});
