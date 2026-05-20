/**
 * Tests for the unified processing-job queue at `src/lib/job-queue.ts`.
 *
 * Verifies:
 * - `tryClaimJob` atomically flips status pending → processing
 * - Two concurrent claims return exactly one winner
 * - `processNextQueueable` is a no-op when something is already processing
 * - FIFO selection orders by createdAt then id
 * - Cancelled rows are skipped; the next pending row picks up
 *
 * Uses the in-memory test DB pattern from `tests/helpers/test-db.ts`. The
 * picker's dispatch is stubbed via `vi.mock` because the real dispatch
 * pulls in server-only modules.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
  type TestDb,
} from "../helpers/test-db";

setupIntegrationDbMock();

// Stub all processors the dispatcher would route to, so the queue never tries
// to actually run a job. We only care about claim/picker logic here.
vi.mock("@/app/camera-trap/actions", () => ({
  processJobInternal: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock("@/app/camera-trap/drive-actions", () => ({
  compressJobInternal: vi.fn().mockResolvedValue(undefined),
  revertJobInternal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/audio/actions", () => ({
  processAudioAnalysisJob: vi.fn().mockResolvedValue(undefined),
  processBirdNETJob: vi.fn().mockResolvedValue(undefined),
  processAcousticIndicesJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audio-compression-core", () => ({
  processFlacCompressionJob: vi.fn().mockResolvedValue(undefined),
  processAudioRevertJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audio-sync-worker", () => ({
  runAudioSyncWorker: vi.fn().mockResolvedValue(undefined),
}));

// Mock only `recordEvent` from system-events so we can assert it's called
// when claimAndEmitStart wins. `buildJobStartEvent` remains real so the
// payload it produces is exercised end-to-end.
vi.mock("@/lib/system-events", async () => {
  const actual = await vi.importActual<typeof import("@/lib/system-events")>(
    "@/lib/system-events",
  );
  return { ...actual, recordEvent: vi.fn().mockResolvedValue(undefined) };
});

const { tryClaimJob, processNextQueueable, isQueueBusy, claimAndEmitStart } =
  await import("@/lib/job-queue");
const ctActions = await import("@/app/camera-trap/actions");
const systemEvents = await import("@/lib/system-events");

let db: TestDb;

function seedJob(opts: {
  jobType: string;
  status?: "pending" | "processing" | "completed" | "failed" | "cancelled";
  createdAt?: Date;
}) {
  const [row] = db
    .insert(schema.processingJobs)
    .values({
      jobType: opts.jobType,
      status: opts.status ?? "pending",
      deploymentId: null,
      totalImages: 0,
      processedImages: 0,
      failedImages: 0,
      createdBy: "test@fcat-ecuador.org",
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning()
    .all();
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
});

describe("tryClaimJob", () => {
  it("flips status from pending to processing on success", async () => {
    const job = seedJob({ jobType: "ml" });
    const won = await tryClaimJob(job.id);
    expect(won).toBe(true);

    const [updated] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, job.id))
      .all();
    expect(updated.status).toBe("processing");
    expect(updated.startedAt).not.toBeNull();
  });

  it("returns false when the row is already processing", async () => {
    const job = seedJob({ jobType: "ml", status: "processing" });
    const won = await tryClaimJob(job.id);
    expect(won).toBe(false);

    const [unchanged] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, job.id))
      .all();
    expect(unchanged.status).toBe("processing");
  });

  it("returns false when the row is in a terminal state", async () => {
    const job = seedJob({ jobType: "ml", status: "completed" });
    expect(await tryClaimJob(job.id)).toBe(false);
  });

  it("only one of two concurrent claims succeeds", async () => {
    const job = seedJob({ jobType: "ml" });
    // better-sqlite3 is synchronous so true parallelism is not possible, but
    // the WHERE clause + .changes pattern is the property we're verifying.
    const [a, b] = await Promise.all([tryClaimJob(job.id), tryClaimJob(job.id)]);
    expect([a, b].filter(Boolean).length).toBe(1);
  });
});

describe("isQueueBusy", () => {
  it("returns false on an empty queue", async () => {
    expect(await isQueueBusy()).toBe(false);
  });

  it("returns true when a queueable job is processing", async () => {
    seedJob({ jobType: "audio_compression", status: "processing" });
    expect(await isQueueBusy()).toBe(true);
  });

  it("ignores non-queueable types like drive_sync", async () => {
    seedJob({ jobType: "drive_sync", status: "processing" });
    expect(await isQueueBusy()).toBe(false);
  });
});

describe("processNextQueueable", () => {
  it("dispatches the oldest pending job in FIFO order", async () => {
    const t0 = new Date("2026-05-01T00:00:00Z");
    const t1 = new Date("2026-05-01T00:00:10Z");
    const t2 = new Date("2026-05-01T00:00:20Z");
    seedJob({ jobType: "ml", createdAt: t1 });
    const oldest = seedJob({ jobType: "audio_compression", createdAt: t0 });
    seedJob({ jobType: "ml_incremental", createdAt: t2 });

    await processNextQueueable();

    const [picked] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, oldest.id))
      .all();
    expect(picked.status).toBe("processing");
  });

  it("is a no-op when something is already processing", async () => {
    seedJob({ jobType: "ml", status: "processing" });
    const pending = seedJob({ jobType: "audio_compression" });

    await processNextQueueable();

    const [unchanged] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, pending.id))
      .all();
    expect(unchanged.status).toBe("pending");
    expect(ctActions.processJobInternal).not.toHaveBeenCalled();
  });

  it("ignores non-queueable types (e.g. drive_sync)", async () => {
    seedJob({ jobType: "drive_sync" }); // not in QUEUEABLE_JOB_TYPES

    await processNextQueueable();

    // The drive_sync row should still be pending — picker didn't touch it.
    const rows = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.status, "pending"))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].jobType).toBe("drive_sync");
  });

  it("skips cancelled rows and picks the next pending one", async () => {
    const t0 = new Date("2026-05-01T00:00:00Z");
    const t1 = new Date("2026-05-01T00:00:10Z");
    seedJob({ jobType: "ml", status: "cancelled", createdAt: t0 });
    const next = seedJob({ jobType: "audio_compression", createdAt: t1 });

    await processNextQueueable();

    const [picked] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, next.id))
      .all();
    expect(picked.status).toBe("processing");
  });

  it("handles an empty queue without throwing", async () => {
    await expect(processNextQueueable()).resolves.toBeUndefined();
  });
});

describe("claimAndEmitStart", () => {
  it("emits a *.started system event when the claim wins", async () => {
    const job = seedJob({ jobType: "audio_compression" });
    const { claimed } = await claimAndEmitStart(job.id);
    expect(claimed).toBe(true);

    // recordEvent should have been called once, with a *.started payload.
    expect(systemEvents.recordEvent).toHaveBeenCalledTimes(1);
    const arg = (systemEvents.recordEvent as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(arg.eventType).toBe("audio_audio_compression.started");
    expect(arg.severity).toBe("info");
    expect(arg.targetType).toBe("processing_job");
  });

  it("does NOT emit when the row is already processing (claim lost)", async () => {
    const job = seedJob({ jobType: "ml", status: "processing" });
    const { claimed } = await claimAndEmitStart(job.id);
    expect(claimed).toBe(false);
    expect(systemEvents.recordEvent).not.toHaveBeenCalled();
  });
});
