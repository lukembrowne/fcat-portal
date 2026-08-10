/**
 * Integration test for the per-species confidence filter.
 *
 * Two properties carry the most risk:
 *
 *  1. BACKWARD COMPATIBILITY — with no applied thresholds the new filter must
 *     select exactly the rows the old global-threshold filter selected. Every
 *     species count, chart, export, and occupancy input in the portal reads
 *     through this predicate.
 *
 *  2. VERIFICATION STATUS STILL WINS — a human who listened to the clip
 *     outranks any threshold, in both directions.
 */

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  applyConfidenceFilter,
  applySpeciesConfidenceFilter,
} from "@/lib/audio-confidence";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;

const TOUCAN = "Ramphastos ambiguus";
const UMBRELLABIRD = "Cephalopterus penduliger";
const OWL = "Pulsatrix perspicillata";

function addIdentification(
  fileId: number,
  species: string,
  confidence: number | null,
  status: "unverified" | "verified" | "rejected" | "corrected"
): number {
  const [detection] = db
    .insert(schema.audioDetections)
    .values({
      audioFileId: fileId,
      startTime: 0,
      endTime: 3,
      minFreq: 100,
      maxFreq: 9000,
      confidence,
    })
    .returning()
    .all();

  const [ident] = db
    .insert(schema.audioIdentifications)
    .values({
      audioDetectionId: detection.id,
      species,
      confidence,
      verificationStatus: status,
    })
    .returning()
    .all();

  return ident.id;
}

/** Ids selected by a given filter fragment. */
function selectWith(filter: ReturnType<typeof applyConfidenceFilter>): number[] {
  const rows = db.all<{ id: number }>(sql`
    SELECT audio_identifications.id AS id
    FROM audio_identifications
    WHERE ${filter}
    ORDER BY id
  `);
  return rows.map((r) => Number(r.id));
}

let fileId: number;

beforeEach(() => {
  db = createTestDb();

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "FilterTestProject" })
    .returning()
    .all();
  const [deployment] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "FLT-001",
      siteName: "FLT-001",
      status: "scanned",
      cameraTrapProjectId: ctProject.id,
    })
    .returning()
    .all();
  const [file] = db
    .insert(schema.audioFiles)
    .values({ deploymentId: deployment.id, filename: "f.flac", driveFileId: "f1" })
    .returning()
    .all();
  fileId = file.id;
});

describe("applySpeciesConfidenceFilter — backward compatibility", () => {
  it("selects exactly the same rows as applyConfidenceFilter when no thresholds are applied", () => {
    // A spread across every status x confidence combination that matters.
    const cases: Array<[string, number | null, "unverified" | "verified" | "rejected" | "corrected"]> = [
      [TOUCAN, 0.05, "unverified"],
      [TOUCAN, 0.3, "unverified"],
      [TOUCAN, 0.7, "unverified"],
      [TOUCAN, 0.95, "unverified"],
      [TOUCAN, null, "unverified"],
      [UMBRELLABIRD, 0.99, "rejected"],
      [UMBRELLABIRD, 0.2, "verified"],
      [OWL, 0.15, "corrected"],
      [OWL, null, "rejected"],
      [OWL, 0.8, "unverified"],
    ];
    for (const [species, conf, status] of cases) {
      addIdentification(fileId, species, conf, status);
    }

    for (const threshold of [0.1, 0.35, 0.7, 0.9, 1.0]) {
      const legacy = selectWith(applyConfidenceFilter(threshold));
      const next = selectWith(applySpeciesConfidenceFilter(threshold, new Map()));
      expect(next).toEqual(legacy);
    }
  });

  it("falls back to the global threshold for a species not in the map", () => {
    const owlLow = addIdentification(fileId, OWL, 0.3, "unverified");
    const owlHigh = addIdentification(fileId, OWL, 0.85, "unverified");

    const map = new Map([[TOUCAN, 0.2]]);
    const selected = selectWith(applySpeciesConfidenceFilter(0.7, map));

    expect(selected).not.toContain(owlLow);
    expect(selected).toContain(owlHigh);
  });
});

describe("applySpeciesConfidenceFilter — per-species behaviour", () => {
  it("keeps a low-scoring detection of a species with a low validated threshold", () => {
    // The toucan case: BirdNET scores it low but is usually right.
    const id = addIdentification(fileId, TOUCAN, 0.3, "unverified");

    expect(selectWith(applyConfidenceFilter(0.7))).not.toContain(id);
    expect(
      selectWith(applySpeciesConfidenceFilter(0.7, new Map([[TOUCAN, 0.2]])))
    ).toContain(id);
  });

  it("drops a high-scoring detection of a species with a high validated threshold", () => {
    // The umbrellabird case: BirdNET is confident and usually wrong.
    const id = addIdentification(fileId, UMBRELLABIRD, 0.85, "unverified");

    expect(selectWith(applyConfidenceFilter(0.7))).toContain(id);
    expect(
      selectWith(applySpeciesConfidenceFilter(0.7, new Map([[UMBRELLABIRD, 0.97]])))
    ).not.toContain(id);
  });

  it("applies each species' own threshold independently", () => {
    const toucanLow = addIdentification(fileId, TOUCAN, 0.25, "unverified");
    const umbrellaHigh = addIdentification(fileId, UMBRELLABIRD, 0.9, "unverified");
    const owlMid = addIdentification(fileId, OWL, 0.75, "unverified");

    const map = new Map([
      [TOUCAN, 0.2],
      [UMBRELLABIRD, 0.98],
    ]);
    const selected = selectWith(applySpeciesConfidenceFilter(0.7, map));

    expect(selected).toContain(toucanLow);
    expect(selected).not.toContain(umbrellaHigh);
    expect(selected).toContain(owlMid); // falls back to global 0.7
  });

  it("does not round a fitted threshold", () => {
    // A detection between the fitted value and its 2-decimal rounding. Rounding
    // 0.9511 down to 0.95 would wrongly admit this row.
    const id = addIdentification(fileId, TOUCAN, 0.9505, "unverified");
    const selected = selectWith(
      applySpeciesConfidenceFilter(0.7, new Map([[TOUCAN, 0.9511]]))
    );
    expect(selected).not.toContain(id);
  });
});

describe("applySpeciesConfidenceFilter — verification status still wins", () => {
  it("always includes verified and corrected rows regardless of any species threshold", () => {
    const verified = addIdentification(fileId, UMBRELLABIRD, 0.1, "verified");
    const corrected = addIdentification(fileId, UMBRELLABIRD, 0.1, "corrected");

    const selected = selectWith(
      applySpeciesConfidenceFilter(0.7, new Map([[UMBRELLABIRD, 0.99]]))
    );
    expect(selected).toContain(verified);
    expect(selected).toContain(corrected);
  });

  it("always excludes rejected rows regardless of any species threshold", () => {
    const rejected = addIdentification(fileId, TOUCAN, 0.99, "rejected");

    const selected = selectWith(
      applySpeciesConfidenceFilter(0.7, new Map([[TOUCAN, 0.1]]))
    );
    expect(selected).not.toContain(rejected);
  });

  it("includes manual annotations with NULL confidence regardless of any species threshold", () => {
    const manual = addIdentification(fileId, TOUCAN, null, "unverified");

    const selected = selectWith(
      applySpeciesConfidenceFilter(0.7, new Map([[TOUCAN, 0.99]]))
    );
    expect(selected).toContain(manual);
  });
});

describe("applySpeciesConfidenceFilter — SQL safety", () => {
  it("parameterises species names containing quotes", () => {
    const weird = "Cyanolyca 'test' \"quoted\"";
    const id = addIdentification(fileId, weird, 0.3, "unverified");

    // Would be a syntax error or an injection if names were interpolated.
    const selected = selectWith(
      applySpeciesConfidenceFilter(0.7, new Map([[weird, 0.2]]))
    );
    expect(selected).toContain(id);
  });

  it("handles a large threshold map without error", () => {
    const id = addIdentification(fileId, TOUCAN, 0.3, "unverified");
    const map = new Map<string, number>();
    for (let i = 0; i < 300; i++) map.set(`Species ${i}`, 0.5);
    map.set(TOUCAN, 0.2);

    expect(selectWith(applySpeciesConfidenceFilter(0.7, map))).toContain(id);
  });

  it("ignores a non-finite threshold instead of generating a comparison against NULL", () => {
    const id = addIdentification(fileId, TOUCAN, 0.85, "unverified");
    const map = new Map([[TOUCAN, Number.NaN]]);

    // NaN would render as a broken comparison; the species must fall back to
    // the global threshold rather than vanishing.
    expect(selectWith(applySpeciesConfidenceFilter(0.7, map))).toContain(id);
  });
});
