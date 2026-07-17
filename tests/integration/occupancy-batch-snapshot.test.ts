/**
 * U6: the weekly modeling batch refreshes the readiness snapshot on completion.
 * The processor's snapshot step is three lines (computeReadinessResult →
 * fingerprint → saveReadinessSnapshot with generatedBy="batch"); this exercises
 * that exact path and confirms the resulting snapshot is batch-attributed and
 * not stale. Failure isolation (a snapshot write throwing must not fail the run)
 * is a plain try/catch in processor.ts around these same functions.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, testDbRef, setupIntegrationDbMock, type TestDb } from "../helpers/test-db";

setupIntegrationDbMock();

import { computeReadinessResult } from "@/lib/occupancy/readiness-compute";
import {
  computeReadinessFingerprint,
  loadLatestReadinessSnapshot,
  saveReadinessSnapshot,
} from "@/lib/occupancy/readiness-snapshot";

let db: TestDb;
let biochocoId: number;

describe("occupancy batch snapshot refresh (U6)", () => {
  beforeEach(() => {
    db = createTestDb();
    testDbRef.current = db;
    const [biochoco] = db.insert(schema.cameraTrapProjects).values({ name: "BioChoco" }).returning().all();
    biochocoId = biochoco.id;
    db.insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "SITE-1",
        siteName: "SITE-1",
        status: "verified",
        cameraTrapProjectId: biochocoId,
        latitude: 0.4,
        longitude: -79.6,
        dateStart: "2026-03-01",
        dateEnd: "2026-03-05",
        excludedAudio: false,
        excludedCamera: false,
      })
      .run();
  });

  it("writes a batch-attributed snapshot that is current afterward", async () => {
    // Mirror processor.ts's post-completion snapshot step exactly.
    const readiness = await computeReadinessResult();
    const fingerprint = computeReadinessFingerprint();
    saveReadinessSnapshot({ result: readiness, fingerprint, generatedBy: "batch" });

    const rows = db.select().from(schema.occupancyReadinessSnapshots).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].generatedBy).toBe("batch");

    const loaded = loadLatestReadinessSnapshot();
    expect(loaded).not.toBeNull();
    // Fingerprint captured with the snapshot matches the current data → not stale.
    expect(loaded!.fingerprint).toBe(computeReadinessFingerprint());
  });
});
