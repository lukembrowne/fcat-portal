import { describe, it, expect } from "vitest";
import {
  buildCounts,
  buildManifest,
  buildCropsCsv,
  CROPS_CSV_COLUMNS,
  type CropCsvRow,
} from "@/lib/training-export-helpers";

describe("buildCounts — source split", () => {
  it("splits train into FCAT vs external and tallies external total", () => {
    const counts = buildCounts([
      { finalLabel: "Leopardus pardalis", split: "train", isExternal: false },
      { finalLabel: "Leopardus pardalis", split: "train", isExternal: true },
      { finalLabel: "Leopardus pardalis", split: "train", isExternal: true },
      { finalLabel: "Leopardus pardalis", split: "val", isExternal: false },
      { finalLabel: "Leopardus pardalis", split: "test", isExternal: false },
    ]);
    expect(counts.external).toBe(2);
    expect(counts.perClass["Leopardus pardalis"]).toEqual({
      train: 3,
      val: 1,
      test: 1,
      trainFcat: 1,
      trainExternal: 2,
    });
    // The toEqual above already proves train === trainFcat + trainExternal (3 = 1 + 2)
    // and that val/test carry no external contribution.
  });

  it("defaults isExternal to false (legacy callers unaffected)", () => {
    const counts = buildCounts([
      { finalLabel: "Cuniculus paca", split: "train" },
    ]);
    expect(counts.external).toBe(0);
    expect(counts.perClass["Cuniculus paca"].trainExternal).toBe(0);
  });
});

describe("crops.csv source_dataset column", () => {
  it("includes source_dataset in the header and per row", () => {
    expect(CROPS_CSV_COLUMNS).toContain("source_dataset");
    const row: CropCsvRow = {
      cropPath: "train/Leopardus pardalis/lila-wcs-9.jpg",
      detectionId: 9,
      imageId: 9,
      deploymentId: 1,
      deploymentName: "LILA: WCS Camera Traps",
      split: "train",
      label: "Leopardus pardalis",
      mlSpecies: null,
      correctedSpecies: null,
      verificationStatus: "verified",
      mdConfidence: 0.9,
      classifierConfidence: null,
      bboxX: 0.1,
      bboxY: 0.1,
      bboxWidth: 0.5,
      bboxHeight: 0.5,
      detectionClass: 0,
      detectorModelVersion: "MDV6-yolov9-c",
      sourceDataset: "wcs",
    };
    const csv = buildCropsCsv([row], {
      cropPadding: 0.05,
      cropLongEdge: 512,
      jpegQuality: 90,
    });
    const idx = CROPS_CSV_COLUMNS.indexOf("source_dataset");
    const dataLine = csv.split("\n")[1].split(",");
    expect(dataLine[idx]).toBe("wcs");
  });
});

describe("buildManifest — externalSources", () => {
  const base = {
    version: "v9",
    contentHash: "abc",
    createdAt: new Date("2026-06-29T00:00:00Z"),
    createdBy: "admin@example.com",
    minExamplesThreshold: 50,
    classList: ["Leopardus pardalis"],
    droppedSpecies: {},
    counts: buildCounts([
      { finalLabel: "Leopardus pardalis", split: "train", isExternal: true },
    ]),
    deployments: [],
    warnings: [],
    pipeline: {
      detectorModel: "MDV6-yolov9-c",
      detectionConfidenceFloor: 0.1,
      detectionThresholdAtCapture: 0.1,
      cropPadding: 0.05,
      cropLongEdge: 512,
      jpegQuality: 90,
    },
  };

  it("emits pipeline.externalSources when external data contributed", () => {
    const m = buildManifest({
      ...base,
      externalSources: [{ dataset: "wcs", imageCount: 1, license: "CC0" }],
    }) as { pipeline: { externalSources?: unknown[] } };
    expect(m.pipeline.externalSources).toEqual([
      { dataset: "wcs", imageCount: 1, license: "CC0" },
    ]);
  });

  it("omits externalSources entirely for a pure-FCAT export", () => {
    const m = buildManifest(base) as {
      pipeline: { externalSources?: unknown[] };
    };
    expect(m.pipeline.externalSources).toBeUndefined();
  });
});
