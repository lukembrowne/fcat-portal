/**
 * Integration tests for scanDeploymentAudioInternal.
 *
 * Uses a real in-memory SQLite database + mocked Drive client to cover
 * all branches of the audio file reconciliation:
 *   - insert new rows for files seen on Drive for the first time
 *   - update existing rows when metadata changes
 *   - soft-delete (null driveFileId) when a Drive file disappears but
 *     the row has annotations (detection rows must stay valid)
 *   - hard-delete rows for Drive files that disappear with no annotations
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, testDbRef, setupIntegrationDbMock, type TestDb } from "../helpers/test-db";

setupIntegrationDbMock();

// Mock the Drive client so we control what scanDeploymentAudioInternal sees.
const mockListFolderFiles = vi.fn();
vi.mock("@/lib/drive-client", () => ({
  listFolderFiles: (...args: unknown[]) => mockListFolderFiles(...args),
  AUDIO_EXTENSIONS: new Set([".wav", ".mp3", ".flac"]),
}));

const { scanDeploymentAudioInternal } = await import(
  "@/lib/audio-sync-internals"
);

let db: TestDb;
let deploymentId: number;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "AudioTestProject" })
    .returning()
    .all();

  const [deployment] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "AUDIO-TEST-001",
      status: "unscanned",
      cameraTrapProjectId: ctProject.id,
      uploadAudioFolderId: "audio_folder_abc",
    })
    .returning()
    .all();
  deploymentId = deployment.id;
});

describe("scanDeploymentAudioInternal", () => {
  it("inserts new rows for files seen on Drive", async () => {
    mockListFolderFiles.mockResolvedValue([
      { id: "f1", name: "rec_001.wav", size: 1024, modifiedTime: "2026-01-01T00:00:00Z" },
      { id: "f2", name: "rec_002.mp3", size: 2048, modifiedTime: "2026-01-02T00:00:00Z" },
    ]);

    const result = await scanDeploymentAudioInternal({
      id: deploymentId,
      uploadAudioFolderId: "audio_folder_abc",
    });

    expect(result).toEqual({ added: 2, updated: 0, total: 2 });

    const rows = db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.deploymentId, deploymentId))
      .all();
    expect(rows).toHaveLength(2);

    const wav = rows.find((r) => r.driveFileId === "f1");
    expect(wav).toBeDefined();
    expect(wav?.filename).toBe("rec_001.wav");
    expect(wav?.format).toBe("wav");
    expect(wav?.playable).toBe(true);
    expect(wav?.mimeType).toBe("audio/wav");
    expect(wav?.fileSize).toBe(1024);
  });

  it("marks non-browser formats as not playable", async () => {
    mockListFolderFiles.mockResolvedValue([
      { id: "f1", name: "rec.wac", size: 1024, modifiedTime: null },
    ]);

    await scanDeploymentAudioInternal({
      id: deploymentId,
      uploadAudioFolderId: "audio_folder_abc",
    });

    const [row] = db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.deploymentId, deploymentId))
      .all();
    expect(row.format).toBe("wac");
    expect(row.playable).toBe(false);
    expect(row.mimeType).toBe("application/octet-stream");
  });

  it("updates existing rows when metadata changes", async () => {
    // First scan: file size 1024
    mockListFolderFiles.mockResolvedValue([
      { id: "f1", name: "rec.wav", size: 1024, modifiedTime: null },
    ]);
    await scanDeploymentAudioInternal({
      id: deploymentId,
      uploadAudioFolderId: "audio_folder_abc",
    });

    // Second scan: file size grew to 2048 (e.g. re-recorded)
    mockListFolderFiles.mockResolvedValue([
      { id: "f1", name: "rec.wav", size: 2048, modifiedTime: "2026-02-01T00:00:00Z" },
    ]);
    const result = await scanDeploymentAudioInternal({
      id: deploymentId,
      uploadAudioFolderId: "audio_folder_abc",
    });

    expect(result).toEqual({ added: 0, updated: 1, total: 1 });

    const [row] = db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.deploymentId, deploymentId))
      .all();
    expect(row.fileSize).toBe(2048);
    expect(row.modifiedAt).toBeInstanceOf(Date);
  });

  it("hard-deletes rows for files that vanished from Drive without annotations", async () => {
    // Seed one file
    mockListFolderFiles.mockResolvedValue([
      { id: "f1", name: "rec.wav", size: 1024, modifiedTime: null },
    ]);
    await scanDeploymentAudioInternal({
      id: deploymentId,
      uploadAudioFolderId: "audio_folder_abc",
    });

    // File disappears
    mockListFolderFiles.mockResolvedValue([]);
    const result = await scanDeploymentAudioInternal({
      id: deploymentId,
      uploadAudioFolderId: "audio_folder_abc",
    });

    expect(result).toEqual({ added: 0, updated: 0, total: 0 });

    const rows = db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.deploymentId, deploymentId))
      .all();
    expect(rows).toHaveLength(0);
  });

  it("soft-deletes (nulls driveFileId) when an annotated file vanishes from Drive", async () => {
    // Seed one file
    mockListFolderFiles.mockResolvedValue([
      { id: "f1", name: "rec.wav", size: 1024, modifiedTime: null },
    ]);
    await scanDeploymentAudioInternal({
      id: deploymentId,
      uploadAudioFolderId: "audio_folder_abc",
    });

    const [seeded] = db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.deploymentId, deploymentId))
      .all();

    // Attach an annotation
    db.insert(schema.audioDetections)
      .values({
        audioFileId: seeded.id,
        startTime: 1.0,
        endTime: 2.5,
        minFreq: 100,
        maxFreq: 5000,
        confidence: 0.9,
      })
      .run();

    // File disappears from Drive
    mockListFolderFiles.mockResolvedValue([]);
    await scanDeploymentAudioInternal({
      id: deploymentId,
      uploadAudioFolderId: "audio_folder_abc",
    });

    // The audio_files row should still exist with driveFileId nulled
    const [row] = db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.id, seeded.id))
      .all();
    expect(row).toBeDefined();
    expect(row.driveFileId).toBeNull();
    expect(row.filename).toBe("rec.wav");

    // The detection must survive
    const detections = db
      .select()
      .from(schema.audioDetections)
      .where(eq(schema.audioDetections.audioFileId, seeded.id))
      .all();
    expect(detections).toHaveLength(1);
  });

  it("handles a mixed scan: insert + update + soft-delete + hard-delete in one pass", async () => {
    // Initial state: two files, one with an annotation
    mockListFolderFiles.mockResolvedValue([
      { id: "keep", name: "keep.wav", size: 100, modifiedTime: null },
      { id: "annotated", name: "annotated.wav", size: 200, modifiedTime: null },
      { id: "doomed", name: "doomed.wav", size: 300, modifiedTime: null },
    ]);
    await scanDeploymentAudioInternal({
      id: deploymentId,
      uploadAudioFolderId: "audio_folder_abc",
    });

    const annotatedRow = db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.driveFileId, "annotated"))
      .all()[0];
    db.insert(schema.audioDetections)
      .values({
        audioFileId: annotatedRow.id,
        startTime: 0,
        endTime: 1,
        minFreq: 100,
        maxFreq: 500,
        confidence: 0.8,
      })
      .run();

    // Next pass: keep size grew, annotated disappears (→ soft-delete),
    // doomed disappears (→ hard-delete), new file appears
    mockListFolderFiles.mockResolvedValue([
      { id: "keep", name: "keep.wav", size: 150, modifiedTime: null },
      { id: "new", name: "new.wav", size: 400, modifiedTime: null },
    ]);
    const result = await scanDeploymentAudioInternal({
      id: deploymentId,
      uploadAudioFolderId: "audio_folder_abc",
    });
    expect(result).toEqual({ added: 1, updated: 1, total: 2 });

    const all = db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.deploymentId, deploymentId))
      .all();

    const byKey = new Map(all.map((r) => [r.filename, r]));
    expect(byKey.get("keep.wav")?.fileSize).toBe(150);
    expect(byKey.get("new.wav")?.driveFileId).toBe("new");
    expect(byKey.get("annotated.wav")?.driveFileId).toBeNull();
    expect(byKey.has("doomed.wav")).toBe(false);
  });
});
