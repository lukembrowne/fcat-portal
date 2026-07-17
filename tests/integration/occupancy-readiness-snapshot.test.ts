/**
 * U3: readiness-snapshot store + fingerprint.
 *  - save → load round-trips the JSON blob and surfaces the stored fingerprint.
 *  - the fingerprint moves on additions / pool-membership changes and is stable
 *    when nothing changed.
 *  - cold start (empty table) loads null; a corrupt blob degrades to null.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import { sql } from "drizzle-orm";
import { createTestDb, testDbRef, setupIntegrationDbMock, type TestDb } from "../helpers/test-db";

setupIntegrationDbMock();

import {
  computeReadinessFingerprint,
  loadLatestReadinessSnapshot,
  saveReadinessSnapshot,
} from "@/lib/occupancy/readiness-snapshot";
import type { OccupancyReadinessResult } from "@/lib/occupancy/readiness-compute";

let db: TestDb;
let biochocoId: number;

function stubResult(generatedAt: string): OccupancyReadinessResult {
  const emptyReport = (stream: "camera" | "audio") => ({
    stream,
    binWidth: 5,
    thresholds: { minSites: 5, minSitesDetected: 3, minDetections: 5, minOccasions: 3 },
    nSites: 2,
    nSitesWithCoords: 2,
    nSpecies: 1,
    nEligibleSpecies: 0,
    detectionsDroppedNoDate: 0,
    species: [
      {
        species: "Panthera onca",
        eligible: false,
        reasons: ["pocos sitios"],
        nSites: 2,
        nSitesDetected: 1,
        totalDetections: 1,
        maxOccasions: 4,
        naiveOccupancy: 0.5,
      },
    ],
  });
  return {
    camera: emptyReport("camera"),
    audio: emptyReport("audio"),
    cameraSitesDropped: 0,
    audioSitesDropped: 0,
    cameraDateAnomalies: [],
    audioDateAnomalies: [],
    audioSubsample: null,
    generatedAt,
  } as unknown as OccupancyReadinessResult;
}

function seedDeployment(name: string, excludedCamera = false): number {
  const [d] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name,
      siteName: name,
      status: "verified",
      cameraTrapProjectId: biochocoId,
      latitude: 0.4,
      longitude: -79.6,
      dateStart: "2026-03-01",
      dateEnd: "2026-03-05",
      excludedAudio: false,
      excludedCamera,
    })
    .returning()
    .all();
  return d.id;
}

function addVerifiedCameraDetection(depId: number, species: string): void {
  const [img] = db
    .insert(schema.images)
    .values({ deploymentId: depId, filename: "IMG_20260302_100000.jpg", status: "processed" })
    .returning()
    .all();
  const [det] = db
    .insert(schema.detections)
    .values({
      imageId: img.id,
      bboxX: 0.1,
      bboxY: 0.1,
      bboxWidth: 0.5,
      bboxHeight: 0.5,
      detectionConfidence: 0.95,
      detectionClass: 0,
    })
    .returning()
    .all();
  db.insert(schema.identifications)
    .values({ detectionId: det.id, species, confidence: 0.9, verificationStatus: "verified" })
    .run();
}

describe("readiness-snapshot store + fingerprint (U3)", () => {
  beforeEach(() => {
    db = createTestDb();
    testDbRef.current = db;
    const [biochoco] = db.insert(schema.cameraTrapProjects).values({ name: "BioChoco" }).returning().all();
    biochocoId = biochoco.id;
  });

  it("round-trips the result blob and surfaces the stored fingerprint", () => {
    const result = stubResult("2026-07-17T12:00:00.000Z");
    saveReadinessSnapshot({ result, fingerprint: "fp-abc", generatedBy: "editor@x.org" });
    const loaded = loadLatestReadinessSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded!.fingerprint).toBe("fp-abc");
    expect(loaded!.generatedBy).toBe("editor@x.org");
    expect(loaded!.result).toEqual(result);
  });

  it("returns the newest snapshot when several exist", () => {
    saveReadinessSnapshot({ result: stubResult("2026-07-17T10:00:00.000Z"), fingerprint: "old" });
    saveReadinessSnapshot({ result: stubResult("2026-07-17T11:00:00.000Z"), fingerprint: "new" });
    expect(loadLatestReadinessSnapshot()!.fingerprint).toBe("new");
  });

  it("cold start: loads null when the table is empty", () => {
    expect(loadLatestReadinessSnapshot()).toBeNull();
  });

  it("corrupt blob degrades to null instead of throwing", () => {
    db.insert(schema.occupancyReadinessSnapshots)
      .values({ binWidthDays: 5, audioConfidenceThreshold: 0.7, resultJson: "{not json", fingerprint: "fp" })
      .run();
    expect(loadLatestReadinessSnapshot()).toBeNull();
  });

  it("fingerprint is stable when nothing changes", () => {
    seedDeployment("STABLE");
    const a = computeReadinessFingerprint();
    const b = computeReadinessFingerprint();
    expect(a).toBe(b);
  });

  it("fingerprint changes when a verified deployment is added", () => {
    seedDeployment("ONE");
    const before = computeReadinessFingerprint();
    seedDeployment("TWO");
    expect(computeReadinessFingerprint()).not.toBe(before);
  });

  it("fingerprint changes when a deployment's camera exclusion is toggled", () => {
    const id = seedDeployment("TOGGLE");
    const before = computeReadinessFingerprint();
    db.run(sql`UPDATE biochoco_deployments SET excluded_camera = 1 WHERE id = ${id}`);
    expect(computeReadinessFingerprint()).not.toBe(before);
  });

  it("fingerprint changes when a new verified detection lands", () => {
    const id = seedDeployment("DET");
    const before = computeReadinessFingerprint();
    addVerifiedCameraDetection(id, "Panthera onca");
    expect(computeReadinessFingerprint()).not.toBe(before);
  });
});
