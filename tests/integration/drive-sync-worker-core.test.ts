/**
 * Integration tests for runDriveSyncWorkerGeneric.
 *
 * The worker core is the shared engine behind both camera-trap and audio
 * Drive syncs. These tests use a real in-memory SQLite db so we can
 * observe the side-effects on `processing_jobs` (status transitions,
 * progress counters, completion message) as the worker fans out over a
 * supplied list of fake deployments.
 *
 * Per-module concerns (Drive listing, ODK matching) are stubbed via the
 * config callbacks — that's the seam this abstraction draws.
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

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// touchAppState writes to `app_state` which the test DDL doesn't seed.
// We don't care about it here — the worker swallows its errors anyway.
vi.mock("@/lib/app-state", () => ({
  touchAppState: vi.fn(async () => {}),
}));

const { runDriveSyncWorkerGeneric } = await import(
  "@/lib/drive-sync-worker-core"
);

let db: TestDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
});

interface FakeDep {
  id: number;
}

function makeJob(overrides: Partial<typeof schema.processingJobs.$inferInsert> = {}) {
  const [job] = db
    .insert(schema.processingJobs)
    .values({
      jobType: "drive_sync",
      status: "pending",
      totalImages: 0,
      processedImages: 0,
      failedImages: 0,
      createdBy: "test",
      ...overrides,
    })
    .returning()
    .all();
  return job;
}

function readJob(id: number) {
  return db
    .select()
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.id, id))
    .all()[0];
}

describe("runDriveSyncWorkerGeneric", () => {
  it("walks listDeployments → scanOne → afterAll and marks completed", async () => {
    const job = makeJob();
    const fakeDeps: FakeDep[] = [{ id: 1 }, { id: 2 }, { id: 3 }];

    const scanOne = vi.fn(async () => {});
    const afterAll = vi.fn(async () => {});

    await runDriveSyncWorkerGeneric<FakeDep>(job.id, {
      jobType: "drive_sync",
      logTag: "test",
      revalidatePath: "/test",
      lastSyncStateKey: "test.lastSync",
      listDeployments: async () => fakeDeps,
      scanOne,
      afterAll,
      discover: async () => ({ createdIds: [42] }),
    });

    expect(scanOne).toHaveBeenCalledTimes(3);
    expect(afterAll).toHaveBeenCalledTimes(1);
    expect(afterAll.mock.calls[0][0]).toEqual([42]);

    const finalJob = readJob(job.id);
    expect(finalJob.status).toBe("completed");
    expect(finalJob.processedImages).toBe(3);
    expect(finalJob.failedImages).toBe(0);
    expect(finalJob.statusMessage).toMatch(/Completado/);
    expect(finalJob.statusMessage).toContain("3 de 3");
  });

  it("survives a failing deployment and continues with the rest", async () => {
    const job = makeJob();
    const fakeDeps: FakeDep[] = [{ id: 1 }, { id: 2 }, { id: 3 }];

    const scanOne = vi.fn(async (dep: FakeDep) => {
      if (dep.id === 2) throw new Error("boom on 2");
    });

    await runDriveSyncWorkerGeneric<FakeDep>(job.id, {
      jobType: "drive_sync",
      logTag: "test",
      revalidatePath: "/test",
      lastSyncStateKey: "test.lastSync",
      listDeployments: async () => fakeDeps,
      scanOne,
    });

    expect(scanOne).toHaveBeenCalledTimes(3);

    const finalJob = readJob(job.id);
    expect(finalJob.status).toBe("completed");
    expect(finalJob.processedImages).toBe(3); // processed + failed
    expect(finalJob.failedImages).toBe(1);
    expect(finalJob.statusMessage).toMatch(/con errores/);
  });

  it("refuses to run jobs of the wrong type", async () => {
    const job = makeJob({ jobType: "drive_sync" });

    const scanOne = vi.fn(async () => {});
    await runDriveSyncWorkerGeneric<FakeDep>(job.id, {
      jobType: "audio_sync", // mismatched on purpose
      logTag: "test",
      revalidatePath: "/test",
      lastSyncStateKey: "test.lastSync",
      listDeployments: async () => [{ id: 1 }],
      scanOne,
    });

    expect(scanOne).not.toHaveBeenCalled();
    // Job row left in its original state (still "pending"), no destructive
    // status writes — refusing rather than corrupting.
    const finalJob = readJob(job.id);
    expect(finalJob.status).toBe("pending");
  });

  it("short-circuits via earlyComplete when discovery says there's nothing to do", async () => {
    const job = makeJob();

    const listDeployments = vi.fn(async () => [] as FakeDep[]);
    const scanOne = vi.fn(async () => {});

    await runDriveSyncWorkerGeneric<FakeDep>(job.id, {
      jobType: "drive_sync",
      logTag: "test",
      revalidatePath: "/test",
      lastSyncStateKey: "test.lastSync",
      discover: async () => ({
        createdIds: [],
        earlyComplete: { statusMessage: "Sin proyectos configurados" },
      }),
      listDeployments,
      scanOne,
    });

    // earlyComplete skips fan-out + afterAll entirely
    expect(listDeployments).not.toHaveBeenCalled();
    expect(scanOne).not.toHaveBeenCalled();

    const finalJob = readJob(job.id);
    expect(finalJob.status).toBe("completed");
    expect(finalJob.statusMessage).toBe("Sin proyectos configurados");
  });

  it("respects cancellation flipped mid-flight (between discovery and fan-out)", async () => {
    const job = makeJob();

    // Simulate the user (or another worker) cancelling the job while
    // discovery is running. The cancellation check before each scanOne
    // invocation should see the new status and skip the work.
    const listDeployments = vi.fn(async () => [{ id: 1 }, { id: 2 }]);
    const scanOne = vi.fn(async () => {});

    await runDriveSyncWorkerGeneric<FakeDep>(job.id, {
      jobType: "drive_sync",
      logTag: "test",
      revalidatePath: "/test",
      lastSyncStateKey: "test.lastSync",
      discover: async () => {
        // Flip to cancelled from inside discovery — simulates the user
        // hitting the cancel button before fan-out begins.
        db.update(schema.processingJobs)
          .set({ status: "cancelled" })
          .where(eq(schema.processingJobs.id, job.id))
          .run();
        return { createdIds: [] };
      },
      listDeployments,
      scanOne,
    });

    // Fan-out's per-task cancellation check should skip every deployment
    expect(scanOne).not.toHaveBeenCalled();

    const finalJob = readJob(job.id);
    expect(finalJob.status).toBe("cancelled");
  });

  it("crashes are captured as failed status, not propagated to caller", async () => {
    const job = makeJob();

    // listDeployments throws unhandled — should be caught by the worker's
    // outer try/catch and recorded on the job row.
    await expect(
      runDriveSyncWorkerGeneric<FakeDep>(job.id, {
        jobType: "drive_sync",
        logTag: "test",
        revalidatePath: "/test",
        lastSyncStateKey: "test.lastSync",
        listDeployments: async () => {
          throw new Error("listing exploded");
        },
        scanOne: async () => {},
      })
    ).resolves.toBeUndefined();

    const finalJob = readJob(job.id);
    expect(finalJob.status).toBe("failed");
    expect(finalJob.errorMessage).toContain("listing exploded");
  });

  it("skips afterAll when there are no created ids (nothing for follow-up)", async () => {
    const job = makeJob();
    const afterAll = vi.fn(async () => {});

    await runDriveSyncWorkerGeneric<FakeDep>(job.id, {
      jobType: "drive_sync",
      logTag: "test",
      revalidatePath: "/test",
      lastSyncStateKey: "test.lastSync",
      discover: async () => ({ createdIds: [] }),
      listDeployments: async () => [{ id: 1 }],
      scanOne: async () => {},
      afterAll,
    });

    expect(afterAll).not.toHaveBeenCalled();
  });
});
