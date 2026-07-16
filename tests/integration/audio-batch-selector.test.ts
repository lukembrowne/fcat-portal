/**
 * Integration test for the overnight-batch SELECTOR query
 * (`selectBatchEligibleAudioDeployments`) against a real in-memory SQLite DB.
 *
 * Regression guard for the 2026-06-18 prod incident: the correlated subqueries
 * interpolated `${deployments.id}`, which Drizzle renders UNQUALIFIED (`"id"`).
 * SQLite then bound that bare `id` to the subquery's own table
 * (`audio_files.id` / `biochoco_processing_jobs.id`) instead of the outer
 * deployment, so `audioFileCount` was 0 for EVERY deployment and the whole
 * batch reported `no_audio`. The pure-function unit tests could not catch this
 * because they hand-build candidate objects and never exercise the SQL. This
 * test does, by asserting a deployment WITH audio files is counted correctly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
  type TestDb,
} from "../helpers/test-db";

setupIntegrationDbMock();

// Old date → always passes the 24h "settled/quiet" check.
const OLD_DATE = "2026-01-01T00:00:00.000Z";

async function insertAudioDeployment(
  db: TestDb,
  opts: { name: string; audioCount: number; fileCount: number; excluded?: boolean },
) {
  const [dep] = await db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: opts.name,
      status: "processed",
      uploadAudioFolderId: `folder-${opts.name}`,
      uploadAudioCount: opts.audioCount,
      previousAudioCount: opts.audioCount, // settled: upload === previous
      uploadNewestAudioDate: OLD_DATE,
      excludedAudio: opts.excluded ?? false,
    })
    .returning();

  if (opts.fileCount > 0) {
    await db.insert(schema.audioFiles).values(
      Array.from({ length: opts.fileCount }, (_, i) => ({
        deploymentId: dep.id,
        filename: `${opts.name}_${i}.wav`,
        driveFileId: `${opts.name}-drive-${i}`,
      })),
    );
  }
  return dep;
}

describe("selectBatchEligibleAudioDeployments (real SQL correlation)", () => {
  let selectBatchEligibleAudioDeployments: typeof import("@/lib/audio-batch")["selectBatchEligibleAudioDeployments"];

  beforeEach(async () => {
    testDbRef.current = createTestDb();
    ({ selectBatchEligibleAudioDeployments } = await import("@/lib/audio-batch"));
  });

  it("counts a deployment's audio files via the correlated subquery (not 0)", async () => {
    const db = testDbRef.current as TestDb;
    const dep = await insertAudioDeployment(db, {
      name: "AUDIO-001",
      audioCount: 3,
      fileCount: 3,
    });

    const { eligible, ineligible } = await selectBatchEligibleAudioDeployments();

    // The core regression: a synced, settled, never-processed deployment is
    // eligible — NOT wrongly reported `no_audio` (the bug counted files as 0).
    expect(ineligible.find((i) => i.deploymentId === dep.id)).toBeUndefined();
    const match = eligible.find((e) => e.deploymentId === dep.id);
    expect(match).toBeDefined();
    expect(match?.cachedAudioCount).toBe(3);
  });

  it("still reports no_audio when a deployment truly has zero files", async () => {
    const db = testDbRef.current as TestDb;
    const dep = await insertAudioDeployment(db, {
      name: "EMPTY-001",
      audioCount: 0,
      fileCount: 0,
    });

    const { eligible, ineligible } = await selectBatchEligibleAudioDeployments();

    expect(eligible.find((e) => e.deploymentId === dep.id)).toBeUndefined();
    expect(ineligible.find((i) => i.deploymentId === dep.id)?.reason).toBe("no_audio");
  });

  it("detects an already-processed deployment via the lastBirdnetAt subquery", async () => {
    const db = testDbRef.current as TestDb;
    const dep = await insertAudioDeployment(db, {
      name: "DONE-001",
      audioCount: 2,
      fileCount: 2,
    });
    // A completed birdnet job → lastBirdnetAtSeconds must correlate to THIS
    // deployment (bug bound it to the jobs table's own id → always null).
    await db.insert(schema.processingJobs).values({
      deploymentId: dep.id,
      jobType: "birdnet",
      status: "completed",
      completedAt: new Date(),
    });

    const { eligible, ineligible } = await selectBatchEligibleAudioDeployments();

    expect(eligible.find((e) => e.deploymentId === dep.id)).toBeUndefined();
    expect(ineligible.find((i) => i.deploymentId === dep.id)?.reason).toBe("already_processed");
  });
});
