/**
 * Integration test for fetchAudioFiles after the acoustic_indices LEFT JOIN.
 *
 * The plan calls this out as a quality gate: a typo to INNER JOIN would
 * silently drop every file that hasn't had indices computed yet. This test
 * guards against that regression.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
  type TestDb,
} from "../helpers/test-db";
import {
  setupAuthMocks,
  mockRequirePermission,
  testUser,
} from "../helpers/mock-auth";

setupIntegrationDbMock();
setupAuthMocks();

const { fetchAudioFiles } = await import("@/app/audio/actions");

let db: TestDb;
let ctProjectId: number;
let deploymentId: number;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
  mockRequirePermission.mockResolvedValue(testUser);

  db.insert(schema.users)
    .values({ email: testUser.email, name: testUser.name })
    .onConflictDoNothing()
    .run();

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "RasterTestProject" })
    .returning()
    .all();
  ctProjectId = ctProject.id;

  db.insert(schema.cameraTrapProjectAccess)
    .values({ userEmail: testUser.email, cameraTrapProjectId: ctProjectId })
    .onConflictDoNothing()
    .run();

  const [dep] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "RAS-001_V1",
      status: "scanned",
      cameraTrapProjectId: ctProjectId,
      siteName: "RAS-001",
      uploadAudioFolderId: "drive_xyz",
    })
    .returning()
    .all();
  deploymentId = dep.id;
});

describe("fetchAudioFiles", () => {
  it("returns files without acoustic_indices rows (LEFT JOIN, not INNER)", async () => {
    // Seed two files with NO acoustic_indices rows.
    db.insert(schema.audioFiles)
      .values([
        {
          deploymentId,
          filename: "2MM21798_20260209_120000.wav",
          driveFileId: "drive_a",
        },
        {
          deploymentId,
          filename: "2MM21798_20260209_120500.wav",
          driveFileId: "drive_b",
        },
      ])
      .run();

    const result = await fetchAudioFiles(deploymentId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toHaveLength(2);
    for (const file of result.data) {
      expect(file.soundscapeSaturation).toBeNull();
      expect(file.acousticComplexityIndex).toBeNull();
      expect(file.frequencyEntropy).toBeNull();
      expect(file.temporalEntropy).toBeNull();
      expect(file.eventsPerSecond).toBeNull();
    }
  });

  it("populates acoustic_indices columns when rows exist", async () => {
    const [file] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "2MM21798_20260209_060000.wav",
        driveFileId: "drive_x",
      })
      .returning()
      .all();

    db.insert(schema.acousticIndices)
      .values({
        audioFileId: file.id,
        soundscapeSaturation: 0.42,
        acousticComplexityIndex: 1234.5,
        frequencyEntropy: 0.91,
        temporalEntropy: 0.77,
        eventsPerSecond: 12.5,
        recordedDate: "2026-02-09",
        dielPeriod: "dawn",
        configHash: "sha256:test",
        computedAt: new Date(),
      })
      .run();

    const result = await fetchAudioFiles(deploymentId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      soundscapeSaturation: 0.42,
      acousticComplexityIndex: 1234.5,
      frequencyEntropy: 0.91,
      temporalEntropy: 0.77,
      eventsPerSecond: 12.5,
    });
  });

  it("returns the union of all files regardless of indices presence", async () => {
    const [withIndices] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "2MM21798_20260209_060000.wav",
        driveFileId: "drive_a",
      })
      .returning()
      .all();

    db.insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "2MM21798_20260209_120000.wav",
        driveFileId: "drive_b",
      })
      .run();

    db.insert(schema.acousticIndices)
      .values({
        audioFileId: withIndices.id,
        soundscapeSaturation: 0.5,
        dielPeriod: "dawn",
        configHash: "sha256:test",
        computedAt: new Date(),
      })
      .run();

    const result = await fetchAudioFiles(deploymentId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Critical: both rows return, even though only one has indices.
    expect(result.data).toHaveLength(2);
    const withSat = result.data.find((f) => f.soundscapeSaturation !== null);
    const withoutSat = result.data.find((f) => f.soundscapeSaturation === null);
    expect(withSat).toBeDefined();
    expect(withoutSat).toBeDefined();
  });

  it("parses recordedDate and recordedTime from the filename", async () => {
    db.insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "2MM21798_20260209_143015.wav",
        driveFileId: "drive_a",
      })
      .run();

    const result = await fetchAudioFiles(deploymentId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data[0].recordedDate).toBe("2026-02-09");
    expect(result.data[0].recordedTime).toBe("14:30:15");
  });

  it("returns null recordedDate/recordedTime for filenames that do not match the pattern", async () => {
    db.insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "random-name.wav",
        driveFileId: "drive_a",
      })
      .run();

    const result = await fetchAudioFiles(deploymentId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data[0].recordedDate).toBeNull();
    expect(result.data[0].recordedTime).toBeNull();
  });

  it("computes detectionCount as identifications passing the confidence filter", async () => {
    const [file] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "2MM21798_20260209_120000.wav",
        driveFileId: "drive_a",
      })
      .returning()
      .all();

    const detections = db
      .insert(schema.audioDetections)
      .values([
        { audioFileId: file.id, startTime: 0, endTime: 1, minFreq: 100, maxFreq: 8000 },
        { audioFileId: file.id, startTime: 2, endTime: 3, minFreq: 100, maxFreq: 8000 },
        { audioFileId: file.id, startTime: 4, endTime: 5, minFreq: 100, maxFreq: 8000 },
      ])
      .returning()
      .all();

    // Three identifications: two pass the default 0.7 threshold, one is below.
    db.insert(schema.audioIdentifications)
      .values([
        { audioDetectionId: detections[0].id, species: "A", confidence: 0.9, verificationStatus: "unverified" },
        { audioDetectionId: detections[1].id, species: "B", confidence: 0.8, verificationStatus: "unverified" },
        { audioDetectionId: detections[2].id, species: "C", confidence: 0.3, verificationStatus: "unverified" },
      ])
      .run();

    const defaultResult = await fetchAudioFiles(deploymentId);
    expect(defaultResult.success).toBe(true);
    if (!defaultResult.success) return;
    expect(defaultResult.data[0].detectionCount).toBe(2);

    // Lower threshold lets the sub-0.7 identification through.
    const permissive = await fetchAudioFiles(deploymentId, { threshold: 0.2 });
    expect(permissive.success).toBe(true);
    if (!permissive.success) return;
    expect(permissive.data[0].detectionCount).toBe(3);

    // Higher threshold drops both 0.8 and 0.9 only when above them.
    const strict = await fetchAudioFiles(deploymentId, { threshold: 0.95 });
    expect(strict.success).toBe(true);
    if (!strict.success) return;
    expect(strict.data[0].detectionCount).toBe(0);
  });
});
