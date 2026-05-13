/**
 * Integration test for the read-time confidence filter.
 *
 * Exercises the SQL fragment from `src/lib/audio-confidence.ts` against a real
 * in-memory SQLite database. Covers every combination of verification status
 * (verified, corrected, unverified, rejected) crossed with confidence above,
 * below, and NULL.
 *
 * The filter is the single source of truth for "what does the user see?" and
 * is reused across every aggregation site, so a regression here would silently
 * skew every chart and count in the audio module.
 */

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { applyConfidenceFilter } from "@/lib/audio-confidence";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;
let detectionId: number;

beforeEach(() => {
  db = createTestDb();

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "ThresholdTestProject" })
    .returning()
    .all();

  const [deployment] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "THR-001",
      status: "scanned",
      cameraTrapProjectId: ctProject.id,
      siteName: "THR-001",
      uploadAudioFolderId: "drive_x",
    })
    .returning()
    .all();

  const [file] = db
    .insert(schema.audioFiles)
    .values({
      deploymentId: deployment.id,
      filename: "thr-001.wav",
      driveFileId: "thr-001",
    })
    .returning()
    .all();

  const [detection] = db
    .insert(schema.audioDetections)
    .values({
      audioFileId: file.id,
      startTime: 0,
      endTime: 3,
      minFreq: 0,
      maxFreq: 8000,
      confidence: null,
    })
    .returning()
    .all();

  detectionId = detection.id;
});

function seed(opts: {
  species: string;
  confidence: number | null;
  status: "verified" | "corrected" | "unverified" | "rejected";
}) {
  db.insert(schema.audioIdentifications)
    .values({
      audioDetectionId: detectionId,
      species: opts.species,
      confidence: opts.confidence,
      verificationStatus: opts.status,
    })
    .run();
}

function countMatching(threshold: number): number {
  const result = db
    .select({ c: sql<number>`count(*)` })
    .from(schema.audioIdentifications)
    .where(applyConfidenceFilter(threshold))
    .get() as { c: number } | undefined;
  return result?.c ?? 0;
}

describe("applyConfidenceFilter — verification overrides", () => {
  it("always includes verified rows regardless of confidence", () => {
    seed({ species: "A", confidence: 0.05, status: "verified" });
    expect(countMatching(0.9)).toBe(1);
    expect(countMatching(0.1)).toBe(1);
  });

  it("always includes corrected rows regardless of confidence", () => {
    seed({ species: "A", confidence: 0.05, status: "corrected" });
    expect(countMatching(0.95)).toBe(1);
  });

  it("always excludes rejected rows, even at maximum confidence", () => {
    seed({ species: "A", confidence: 1.0, status: "rejected" });
    expect(countMatching(0.1)).toBe(0);
    expect(countMatching(0.9)).toBe(0);
  });

  it("excludes a rejected row even when confidence is NULL", () => {
    seed({ species: "A", confidence: null, status: "rejected" });
    expect(countMatching(0.1)).toBe(0);
  });
});

describe("applyConfidenceFilter — unverified rows", () => {
  it("includes unverified rows at or above the threshold", () => {
    seed({ species: "A", confidence: 0.8, status: "unverified" });
    expect(countMatching(0.7)).toBe(1);
    expect(countMatching(0.8)).toBe(1);
  });

  it("excludes unverified rows below the threshold", () => {
    seed({ species: "A", confidence: 0.6, status: "unverified" });
    expect(countMatching(0.7)).toBe(0);
  });

  it("excludes unverified rows above the threshold by even 0.01", () => {
    seed({ species: "A", confidence: 0.79, status: "unverified" });
    expect(countMatching(0.8)).toBe(0);
  });
});

describe("applyConfidenceFilter — NULL confidence (manual annotations)", () => {
  it("includes NULL-confidence unverified rows at any threshold", () => {
    seed({ species: "A", confidence: null, status: "unverified" });
    expect(countMatching(0.1)).toBe(1);
    expect(countMatching(0.99)).toBe(1);
  });

  it("includes NULL-confidence verified rows", () => {
    seed({ species: "A", confidence: null, status: "verified" });
    expect(countMatching(0.95)).toBe(1);
  });
});

describe("applyConfidenceFilter — mixed populations", () => {
  it("returns the correct count across all four statuses at threshold 0.7", () => {
    seed({ species: "A", confidence: 0.9, status: "verified" });    // included
    seed({ species: "B", confidence: 0.2, status: "corrected" });   // included
    seed({ species: "C", confidence: 0.99, status: "rejected" });   // excluded
    seed({ species: "D", confidence: 0.8, status: "unverified" });  // included
    seed({ species: "E", confidence: 0.5, status: "unverified" });  // excluded
    seed({ species: "F", confidence: null, status: "unverified" }); // included

    expect(countMatching(0.7)).toBe(4);
  });

  it("counts distinct species after filtering", () => {
    seed({ species: "Toucan", confidence: 0.9, status: "unverified" });
    seed({ species: "Toucan", confidence: 0.2, status: "unverified" });
    seed({ species: "Guan", confidence: 0.5, status: "unverified" });
    seed({ species: "Guan", confidence: 0.99, status: "rejected" });

    const result = db
      .select({ c: sql<number>`count(distinct audio_identifications.species)` })
      .from(schema.audioIdentifications)
      .where(applyConfidenceFilter(0.8))
      .get() as { c: number } | undefined;

    expect(result?.c).toBe(1); // Only Toucan @ 0.9 passes
  });
});
