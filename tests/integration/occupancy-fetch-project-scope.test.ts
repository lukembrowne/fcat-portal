/**
 * U2: fetchOccupancyInputs scopes its image / audio-file / detection scans to
 * the BioChoco camera-trap project. Deployments (and their images/recordings)
 * belonging to OTHER ct_projects must never enter the occupancy inputs — the
 * filter now lives in SQL, but the result is identical to the prior JS-side
 * poolIds drop.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, testDbRef, setupIntegrationDbMock, type TestDb } from "../helpers/test-db";

setupIntegrationDbMock();

import { fetchOccupancyInputs } from "@/lib/occupancy/fetch";

let db: TestDb;
let biochocoId: number;
let otherId: number;

function seedDeployment(name: string, ctProjectId: number): number {
  const [d] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name,
      siteName: name,
      status: "verified",
      cameraTrapProjectId: ctProjectId,
      latitude: 0.4,
      longitude: -79.6,
      dateStart: "2026-03-01",
      dateEnd: "2026-03-05",
      excludedAudio: false,
      excludedCamera: false,
    })
    .returning()
    .all();
  return d.id;
}

function addImage(depId: number, filename: string): number {
  const [img] = db
    .insert(schema.images)
    .values({ deploymentId: depId, filename, status: "processed" })
    .returning()
    .all();
  return img.id;
}

function addCameraDetection(imageId: number, species: string): void {
  const [det] = db
    .insert(schema.detections)
    .values({
      imageId,
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

function addAudioFile(depId: number, ymd: string, hms: string): number {
  const [f] = db
    .insert(schema.audioFiles)
    .values({ deploymentId: depId, filename: `2MM00000_${ymd}_${hms}.wav` })
    .returning()
    .all();
  return f.id;
}

function addAudioDetection(fileId: number, species: string): void {
  const [det] = db
    .insert(schema.audioDetections)
    .values({ audioFileId: fileId, startTime: 0, endTime: 3, minFreq: 500, maxFreq: 8000, confidence: 0.99 })
    .returning()
    .all();
  db.insert(schema.audioIdentifications)
    .values({ audioDetectionId: det.id, species, confidence: 0.99 })
    .run();
}

describe("fetchOccupancyInputs — BioChoco project scoping (U2)", () => {
  beforeEach(() => {
    db = createTestDb();
    testDbRef.current = db;
    const [biochoco] = db.insert(schema.cameraTrapProjects).values({ name: "BioChoco" }).returning().all();
    const [other] = db.insert(schema.cameraTrapProjects).values({ name: "OtherProject" }).returning().all();
    biochocoId = biochoco.id;
    otherId = other.id;
  });

  it("camera: excludes images + detections from a non-BioChoco project", () => {
    const bio = seedDeployment("BIO-CAM", biochocoId);
    const bioImg = addImage(bio, "IMG_20260302_100000.jpg");
    addCameraDetection(bioImg, "Panthera onca");

    const other = seedDeployment("OTHER-CAM", otherId);
    const otherImg = addImage(other, "IMG_20260302_100000.jpg");
    addCameraDetection(otherImg, "Panthera onca");

    const inputs = fetchOccupancyInputs("camera");
    const siteIds = inputs.sites.map((s) => s.siteId);
    expect(siteIds).toContain(String(bio));
    expect(siteIds).not.toContain(String(other));
    // Only the BioChoco detection survives.
    expect(inputs.detections.every((d) => d.siteId === String(bio))).toBe(true);
    expect(inputs.detections).toHaveLength(1);
  });

  it("audio: excludes recordings + detections from a non-BioChoco project", () => {
    const bio = seedDeployment("BIO-AUD", biochocoId);
    const bioFile = addAudioFile(bio, "20260302", "100000");
    addAudioDetection(bioFile, "Tinamus major");

    const other = seedDeployment("OTHER-AUD", otherId);
    const otherFile = addAudioFile(other, "20260302", "100000");
    addAudioDetection(otherFile, "Tinamus major");

    const inputs = fetchOccupancyInputs("audio");
    const siteIds = inputs.sites.map((s) => s.siteId);
    expect(siteIds).toContain(String(bio));
    expect(siteIds).not.toContain(String(other));
    expect(inputs.detections.every((d) => d.siteId === String(bio))).toBe(true);
    expect(inputs.detections).toHaveLength(1);
    // Subsample summary is computed over the BioChoco pool only.
    expect(inputs.audioSubsample!.filesTotal).toBe(1);
  });

  it("audio: preserves the confidence-OR-verified predicate under the pool filter", () => {
    const bio = seedDeployment("BIO-CONF", biochocoId);
    const f = addAudioFile(bio, "20260302", "100000");
    // A low-confidence, unverified detection must NOT count (below default 0.7).
    const [det] = db
      .insert(schema.audioDetections)
      .values({ audioFileId: f, startTime: 0, endTime: 3, minFreq: 500, maxFreq: 8000, confidence: 0.2 })
      .returning()
      .all();
    db.insert(schema.audioIdentifications)
      .values({ audioDetectionId: det.id, species: "Crax rubra", confidence: 0.2, verificationStatus: "unverified" })
      .run();

    const inputs = fetchOccupancyInputs("audio");
    expect(inputs.detections.filter((d) => d.species === "Crax rubra")).toHaveLength(0);
  });
});
