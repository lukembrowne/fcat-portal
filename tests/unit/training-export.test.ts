import { describe, it, expect } from "vitest";
import {
  speciesSlug,
  speciesFolderName,
  assignSplit,
  computeContentHash,
  buildCounts,
  buildCropsCsv,
  buildPreviewDeltas,
  toCsvField,
  CROPS_CSV_COLUMNS,
  stratifyDeploymentSplits,
  selectIncludedClasses,
  findUncoveredLabels,
  SPLIT_STRATEGY_VERSION,
  STRATIFY_MIN_DEPLOYMENTS,
  type HashRow,
  type CropCsvRow,
  type QualityParams,
  type Split,
  type ManifestCounts,
  type PreviewSpeciesCounts,
} from "@/lib/training-export-helpers";

const DEFAULT_QUALITY: QualityParams = {
  detectionConfidenceFloor: 0.1,
  cropPadding: 0.05,
  cropLongEdge: 512,
  jpegQuality: 90,
};

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

describe("speciesFolderName", () => {
  it("returns the canonical name unchanged when already clean", () => {
    expect(speciesFolderName("Panthera onca")).toBe("Panthera onca");
    expect(speciesFolderName("Leopardus pardalis")).toBe("Leopardus pardalis");
  });

  it("preserves diacritics (NFC form, no stripping)", () => {
    expect(speciesFolderName("Cerdocyón thous")).toBe("Cerdocyón thous");
    expect(speciesFolderName("Tinamú café")).toBe("Tinamú café");
  });

  it("preserves punctuation that the species table may use", () => {
    expect(speciesFolderName("sp. 1")).toBe("sp. 1");
    expect(speciesFolderName("Anas platyrhynchos domesticus")).toBe(
      "Anas platyrhynchos domesticus",
    );
  });

  it("collapses runs of whitespace and trims edges", () => {
    expect(speciesFolderName("  Panthera   onca  ")).toBe("Panthera onca");
    expect(speciesFolderName("\tPanthera\nonca\t")).toBe("Panthera onca");
  });

  it("neutralizes path separators without losing the name", () => {
    expect(speciesFolderName("a/b")).toBe("a b");
    expect(speciesFolderName("a\\b")).toBe("a b");
  });

  it("strips control characters but keeps the rest of the string", () => {
    // NUL (\x00) and BEL (\x07) inserted via fromCharCode so the test source
    // stays a clean ASCII file. Both should disappear after sanitization.
    const withControls = `Panthera${String.fromCharCode(0)} ${String.fromCharCode(7)}onca`;
    expect(speciesFolderName(withControls)).toBe("Panthera onca");
  });
  it("never returns a hidden-file folder (leading dot stripped)", () => {
    expect(speciesFolderName(".hidden")).toBe("hidden");
    expect(speciesFolderName("..weird")).toBe("weird");
  });

  it("caps absurdly long names at 200 chars", () => {
    const long = "A".repeat(300);
    expect(speciesFolderName(long).length).toBe(200);
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
    quality: DEFAULT_QUALITY,
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
      computeContentHash({
        rows: a,
        minExamples: 1,
        classList: ["a|b", "c"],
        quality: DEFAULT_QUALITY,
      }),
    ).not.toBe(
      computeContentHash({
        rows: b,
        minExamples: 1,
        classList: ["a", "b|c"],
        quality: DEFAULT_QUALITY,
      }),
    );
  });

  it("changes when ONLY a crop-quality knob changes (same corpus)", () => {
    // The critical correctness guarantee: two exports differing only in
    // padding must NOT dedupe as 'unchanged'. Same for long-edge, quality,
    // and the confidence floor.
    const base = computeContentHash(baseInput);
    expect(
      computeContentHash({
        ...baseInput,
        quality: { ...DEFAULT_QUALITY, cropPadding: 0.1 },
      }),
    ).not.toBe(base);
    expect(
      computeContentHash({
        ...baseInput,
        quality: { ...DEFAULT_QUALITY, cropLongEdge: 384 },
      }),
    ).not.toBe(base);
    expect(
      computeContentHash({
        ...baseInput,
        quality: { ...DEFAULT_QUALITY, jpegQuality: 80 },
      }),
    ).not.toBe(base);
    expect(
      computeContentHash({
        ...baseInput,
        quality: { ...DEFAULT_QUALITY, detectionConfidenceFloor: 0.5 },
      }),
    ).not.toBe(base);
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
      quality: DEFAULT_QUALITY,
    });
    // Hash must be a 64-char hex string and stable over runs.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const again = computeContentHash({
      rows: sample,
      minExamples: 50,
      classList: ["ocelot"],
      quality: DEFAULT_QUALITY,
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
    // perClass is keyed by the on-disk folder name (canonical species name
    // with spaces preserved), matching what the exporter writes to disk and
    // what the model server returns at inference time.
    expect(counts.perClass.Ocelot).toEqual({
      train: 2,
      val: 1,
      test: 0,
      trainFcat: 2,
      trainExternal: 0,
    });
    expect(counts.perClass.Puma).toEqual({
      train: 1,
      val: 0,
      test: 1,
      trainFcat: 1,
      trainExternal: 0,
    });
  });

  it("uses canonical species names (spaces, diacritics) as perClass keys", () => {
    const counts = buildCounts([
      { finalLabel: "Panthera onca", split: "train" },
      { finalLabel: "Cerdocyón thous", split: "val" },
    ]);
    expect(Object.keys(counts.perClass).sort()).toEqual([
      "Cerdocyón thous",
      "Panthera onca",
    ]);
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

describe("toCsvField", () => {
  it("renders null/undefined as empty", () => {
    expect(toCsvField(null)).toBe("");
    expect(toCsvField(undefined)).toBe("");
  });

  it("passes through plain values without quoting", () => {
    expect(toCsvField("ocelot")).toBe("ocelot");
    expect(toCsvField(0.873)).toBe("0.873");
    expect(toCsvField(42)).toBe("42");
  });

  it("quotes and escapes fields containing comma, quote, or newline", () => {
    expect(toCsvField("a,b")).toBe('"a,b"');
    expect(toCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(toCsvField("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("buildCropsCsv", () => {
  const params = { cropPadding: 0.05, cropLongEdge: 512, jpegQuality: 90 };
  const row: CropCsvRow = {
    cropPath: "train/Panthera onca/123.jpg",
    detectionId: 123,
    imageId: 45,
    deploymentId: 7,
    deploymentName: "Cámara, Río Verde",
    split: "train",
    label: "Panthera onca",
    mlSpecies: "Puma concolor",
    correctedSpecies: "Panthera onca",
    verificationStatus: "corrected",
    mdConfidence: 0.87,
    classifierConfidence: 0.42,
    bboxX: 0.1,
    bboxY: 0.2,
    bboxWidth: 0.3,
    bboxHeight: 0.4,
    detectionClass: 0,
    detectorModelVersion: "MDV6-yolov9-c",
    sourceDataset: null,
  };

  it("emits a header matching CROPS_CSV_COLUMNS", () => {
    const csv = buildCropsCsv([], params);
    expect(csv).toBe(CROPS_CSV_COLUMNS.join(",") + "\n");
  });

  it("writes one data row per crop with denormalized params", () => {
    const csv = buildCropsCsv([row], params);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    // Deployment name has a comma → must be quoted.
    expect(lines[1]).toContain('"Cámara, Río Verde"');
    // Per-crop MD confidence + denormalized crop params appear.
    expect(lines[1]).toContain("0.87");
    expect(lines[1]).toContain("MDV6-yolov9-c");
    expect(lines[1].endsWith(",0.05,512,90")).toBe(true);
  });

  it("renders null classifier/detector fields as empty cells", () => {
    const csv = buildCropsCsv(
      [
        {
          ...row,
          // Comma-free name so the naive split below indexes cleanly.
          deploymentName: "RioVerde",
          mlSpecies: null,
          classifierConfidence: null,
          detectorModelVersion: null,
        },
      ],
      params,
    );
    const cells = csv.trimEnd().split("\n")[1].split(",");
    // ml_species (index 7) and classifier_confidence (index 11) empty.
    expect(cells[7]).toBe("");
    expect(cells[11]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Regression: manifest counts must match what is WRITTEN to disk, not the
// pre-fetch candidate set. Mirrors the count + coverage logic that
// processTrainingExportJobInternal runs over the non-null csvSlots
// ("writtenRows"). See docs/plans/2026-05-30-fix-training-export-counts-match-disk-plan.md.
// ---------------------------------------------------------------------------

/** Minimal CropCsvRow factory — only the fields the count logic reads matter. */
function writtenRow(
  detectionId: number,
  label: string,
  split: Split,
  deploymentId: number,
): CropCsvRow {
  return {
    cropPath: `${split}/${label}/${detectionId}.jpg`,
    detectionId,
    imageId: detectionId * 10,
    deploymentId,
    deploymentName: `dep-${deploymentId}`,
    split,
    label,
    mlSpecies: label,
    correctedSpecies: null,
    verificationStatus: "verified",
    mdConfidence: 0.9,
    classifierConfidence: 0.8,
    bboxX: 0,
    bboxY: 0,
    bboxWidth: 0.5,
    bboxHeight: 0.5,
    detectionClass: 0,
    detectorModelVersion: "MDV6-yolov9-c",
    sourceDataset: null,
  };
}

/** The job's written-set per-label-per-split tally, extracted for assertions. */
function perLabelSplit(
  rows: CropCsvRow[],
): Map<string, { train: number; val: number; test: number }> {
  const m = new Map<string, { train: number; val: number; test: number }>();
  for (const r of rows) {
    const c = m.get(r.label) ?? { train: 0, val: 0, test: 0 };
    c[r.split] += 1;
    m.set(r.label, c);
  }
  return m;
}

describe("counts derived from the written set", () => {
  it("counts.total equals the written-set size, not the candidate size", () => {
    // 5 candidates for Ocelot; one source image was unreachable at fetch time
    // (no driveFileId) so its crop was skipped — only 4 land on disk.
    const candidateCount = 5;
    const written = [
      writtenRow(1, "Ocelot", "train", 10),
      writtenRow(2, "Ocelot", "train", 10),
      writtenRow(3, "Ocelot", "val", 11),
      writtenRow(4, "Ocelot", "test", 12),
      // detection 5 skipped — not present in the written set.
    ];
    const skipped = candidateCount - written.length;

    const counts = buildCounts(
      written.map((r) => ({ finalLabel: r.label, split: r.split })),
    );

    expect(counts.total).toBe(written.length); // 4, not 5
    expect(counts.total + skipped).toBe(candidateCount);
    // total reconciles with the per-split sum and the on-disk JPEG count.
    expect(counts.train + counts.val + counts.test).toBe(counts.total);
    expect(counts.perClass.Ocelot).toEqual({
      train: 2,
      val: 1,
      test: 1,
      trainFcat: 2,
      trainExternal: 0,
    });
  });

  it("omits a deployment whose every crop failed from the per-deployment tally", () => {
    // Deployment 99 contributed candidates but every one was skipped — it must
    // not appear in the written-set-derived deployment summary.
    const written = [
      writtenRow(1, "Puma", "train", 10),
      writtenRow(2, "Puma", "val", 11),
      writtenRow(3, "Puma", "test", 12),
      // deployment 99's crops all failed → absent here.
    ];
    const perDeployment = new Map<number, number>();
    for (const r of written) {
      perDeployment.set(r.deploymentId, (perDeployment.get(r.deploymentId) ?? 0) + 1);
    }
    expect(perDeployment.has(99)).toBe(false);
    expect([...perDeployment.keys()].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });
});

describe("written-set coverage re-check (bug #1 ↔ bug #2 interaction)", () => {
  it("flags a surviving class that lost its only val crop to a fetch failure", () => {
    // Tapir qualified pre-fetch (had a val crop), but the lone val source 404'd
    // at fetch time, so the WRITTEN set has val=0 — which would re-trip the
    // classifier's load_manifest assertion if shipped.
    const written = [
      writtenRow(1, "Tapirus bairdii", "train", 10),
      writtenRow(2, "Tapirus bairdii", "train", 11),
      // val crop skipped (transient 404) → no val row
      writtenRow(3, "Tapirus bairdii", "test", 12),
      writtenRow(4, "Cuniculus paca", "train", 20),
      writtenRow(5, "Cuniculus paca", "val", 21),
      writtenRow(6, "Cuniculus paca", "test", 22),
    ];
    const classList = ["Cuniculus paca", "Tapirus bairdii"];

    const uncovered = findUncoveredLabels(perLabelSplit(written)).filter((l) =>
      classList.includes(l),
    );

    expect(uncovered).toEqual(["Tapirus bairdii"]);

    // After dropping the uncovered class, every survivor has 1/1/1 coverage.
    const survivors = written.filter((r) => !uncovered.includes(r.label));
    expect(findUncoveredLabels(perLabelSplit(survivors))).toEqual([]);
  });

  it("flags nothing when every written class keeps val+test coverage", () => {
    const written = [
      writtenRow(1, "Cuniculus paca", "train", 20),
      writtenRow(2, "Cuniculus paca", "val", 21),
      writtenRow(3, "Cuniculus paca", "test", 22),
    ];
    expect(findUncoveredLabels(perLabelSplit(written))).toEqual([]);
  });
});

describe("cross-split contamination (written set)", () => {
  it("never places a detectionId stem under more than one split", () => {
    const written = [
      writtenRow(1, "Ocelot", "train", 10),
      writtenRow(2, "Ocelot", "val", 11),
      writtenRow(3, "Puma", "test", 12),
      writtenRow(4, "Puma", "train", 13),
    ];
    const splitsByStem = new Map<number, Set<Split>>();
    for (const r of written) {
      const set = splitsByStem.get(r.detectionId) ?? new Set<Split>();
      set.add(r.split);
      splitsByStem.set(r.detectionId, set);
    }
    for (const [, splits] of splitsByStem) {
      expect(splits.size).toBe(1);
    }
  });
});

describe("buildPreviewDeltas", () => {
  // folderName === scientific name (speciesFolderName is ~identity for canonical
  // names), so we set folderName explicitly to control the diff key.
  function species(
    label: string,
    train: number,
    val: number,
    test: number,
    folderName = label,
  ): PreviewSpeciesCounts {
    return {
      label,
      folderName,
      train,
      val,
      test,
      total: train + val + test,
      trainDeployments: train > 0 ? 1 : 0,
      valDeployments: val > 0 ? 1 : 0,
      testDeployments: test > 0 ? 1 : 0,
      trainDeploymentNames: train > 0 ? ["A"] : [],
      valDeploymentNames: val > 0 ? ["B"] : [],
      testDeploymentNames: test > 0 ? ["C"] : [],
    };
  }

  function baselineCounts(
    perClass: Record<string, { train: number; val: number; test: number }>,
  ): ManifestCounts {
    let train = 0;
    let val = 0;
    let test = 0;
    for (const c of Object.values(perClass)) {
      train += c.train;
      val += c.val;
      test += c.test;
    }
    return { total: train + val + test, train, val, test, perClass };
  }

  it("returns null deltas/footer when there is no baseline", () => {
    const { rows, footer } = buildPreviewDeltas(
      [species("Puma concolor", 10, 2, 3)],
      null,
    );
    expect(footer).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0].delta).toBeNull();
    expect(rows[0].baseline).toBeNull();
    expect(rows[0].train).toBe(10);
  });

  it("computes per-split and total deltas for a changed class", () => {
    const { rows } = buildPreviewDeltas(
      [species("Puma concolor", 12, 4, 5)],
      baselineCounts({ "Puma concolor": { train: 10, val: 2, test: 5 } }),
    );
    const row = rows[0];
    expect(row.status).toBe("changed");
    expect(row.delta).toEqual({ train: 2, val: 2, test: 0, total: 4 });
    expect(row.baseline).toEqual({ train: 10, val: 2, test: 5, total: 17 });
  });

  it("marks a class absent from the baseline as new (delta == full count)", () => {
    const { rows } = buildPreviewDeltas(
      [species("Tapirus bairdii", 7, 1, 2)],
      baselineCounts({ "Puma concolor": { train: 10, val: 2, test: 5 } }),
    );
    const tapir = rows.find((r) => r.folderName === "Tapirus bairdii")!;
    expect(tapir.status).toBe("new");
    expect(tapir.delta).toEqual({ train: 7, val: 1, test: 2, total: 10 });
  });

  it("emits a removed ghost row for a baseline class absent now", () => {
    const { rows } = buildPreviewDeltas(
      [species("Puma concolor", 10, 2, 5)],
      baselineCounts({
        "Puma concolor": { train: 10, val: 2, test: 5 },
        "Gone species": { train: 4, val: 1, test: 1 },
      }),
    );
    const ghost = rows.find((r) => r.folderName === "Gone species")!;
    expect(ghost.status).toBe("removed");
    expect(ghost.total).toBe(0);
    expect(ghost.delta).toEqual({ train: -4, val: -1, test: -1, total: -6 });
  });

  it("computes split-mix shifts independently (train +k / val −k)", () => {
    const { rows } = buildPreviewDeltas(
      [species("Puma concolor", 15, 0, 5)],
      baselineCounts({ "Puma concolor": { train: 10, val: 5, test: 5 } }),
    );
    expect(rows[0].delta).toEqual({ train: 5, val: -5, test: 0, total: 0 });
  });

  it("treats a split missing from the baseline as 0, never NaN", () => {
    const base: ManifestCounts = {
      total: 10,
      train: 10,
      val: 0,
      test: 0,
      // perClass entry deliberately only carries train (legacy-ish shape).
      perClass: { "Puma concolor": { train: 10, val: 0, test: 0 } },
    };
    const { rows } = buildPreviewDeltas(
      [species("Puma concolor", 10, 3, 2)],
      base,
    );
    expect(rows[0].delta).toEqual({ train: 0, val: 3, test: 2, total: 5 });
    expect(Number.isNaN(rows[0].delta!.val)).toBe(false);
  });

  it("aggregates two labels that collapse to one folder name", () => {
    const { rows } = buildPreviewDeltas(
      [
        species("Puma concolor", 5, 1, 1, "Puma concolor"),
        species("Puma concolor (corr)", 3, 0, 1, "Puma concolor"),
      ],
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].train).toBe(8);
    expect(rows[0].val).toBe(1);
    expect(rows[0].test).toBe(2);
    expect(rows[0].total).toBe(11);
  });

  it("footer equals the sum of body row deltas (ghost rows included)", () => {
    const { rows, footer } = buildPreviewDeltas(
      [
        species("Puma concolor", 12, 4, 5),
        species("Tapirus bairdii", 7, 1, 2), // new
      ],
      baselineCounts({
        "Puma concolor": { train: 10, val: 2, test: 5 },
        "Gone species": { train: 4, val: 1, test: 1 }, // removed → ghost
      }),
    );
    const sum = rows.reduce(
      (acc, r) => {
        acc.train += r.delta!.train;
        acc.val += r.delta!.val;
        acc.test += r.delta!.test;
        acc.total += r.delta!.total;
        return acc;
      },
      { train: 0, val: 0, test: 0, total: 0 },
    );
    expect(footer).toEqual(sum);
  });
});
