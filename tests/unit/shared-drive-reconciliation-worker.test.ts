import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
} from "../helpers/test-db";

setupIntegrationDbMock();

// Mock only the Drive API surface the worker uses; the rest runs for real.
vi.mock("@/lib/drive-client", () => ({
  getSharedDriveMetadata: vi.fn(),
  countSharedDriveItems: vi.fn(),
  getChangesStartPageToken: vi.fn(),
  listSharedDriveChangesDelta: vi.fn(),
}));

const driveClient = await import("@/lib/drive-client");
const { runReconciliationJob } = await import(
  "@/lib/shared-drive-reconciliation-worker"
);

const getMeta = vi.mocked(driveClient.getSharedDriveMetadata);
const countItems = vi.mocked(driveClient.countSharedDriveItems);
const startToken = vi.mocked(driveClient.getChangesStartPageToken);
const delta = vi.mocked(driveClient.listSharedDriveChangesDelta);

const WEDNESDAY = new Date("2026-05-20T12:00:00Z"); // getUTCDay() === 3
const SUNDAY = new Date("2026-05-24T12:00:00Z"); // getUTCDay() === 0

function seedDrive(over: Partial<schema.NewSharedDrive> & { id: string }) {
  testDbRef.current
    .insert(schema.sharedDrives)
    .values({
      driveId: `0A${over.id.padEnd(16, "x")}`,
      rootFolderId: `root-${over.id}`,
      name: over.id,
      status: "active",
      ...over,
    })
    .run();
}

function insertReconcileJob(): number {
  const [job] = testDbRef.current
    .insert(schema.processingJobs)
    .values({
      jobType: "shared_drives_reconcile",
      status: "pending",
      totalImages: 0,
      processedImages: 0,
      failedImages: 0,
    })
    .returning()
    .all();
  return job.id;
}

function drive(id: string) {
  return testDbRef.current.get(
    sql`SELECT * FROM shared_drives WHERE id = ${id}`,
  ) as Record<string, unknown>;
}

function events(eventType?: string) {
  const rows = testDbRef.current.all(
    sql`SELECT event_type, severity, target_id FROM system_events WHERE source = 'shared-drives'`,
  ) as { event_type: string; severity: string; target_id: string }[];
  return eventType ? rows.filter((r) => r.event_type === eventType) : rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  testDbRef.current = createTestDb();
  getMeta.mockResolvedValue({ name: "Drive", createdTime: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runReconciliationJob — delta path (weekday, token present)", () => {
  it("applies the changes.list delta to reconciled_count", async () => {
    vi.setSystemTime(WEDNESDAY);
    seedDrive({ id: "a", reconciledCount: 100_000, changesPageToken: "tok-1" });
    delta.mockResolvedValue({ delta: 250, newStartPageToken: "tok-2" });

    const jobId = insertReconcileJob();
    await runReconciliationJob(jobId);

    const d = drive("a");
    expect(d.reconciled_count).toBe(100_250);
    expect(d.changes_page_token).toBe("tok-2");
    expect(countItems).not.toHaveBeenCalled();
    expect(delta).toHaveBeenCalledWith("0Aaxxxxxxxxxxxxxxx".slice(0, 18), "tok-1");

    const [job] = testDbRef.current
      .select()
      .from(schema.processingJobs)
      .where(sql`${schema.processingJobs.id} = ${jobId}`)
      .all();
    expect(job.status).toBe("completed");
  });
});

describe("runReconciliationJob — full path", () => {
  it("Sunday triggers a full count + token rotation", async () => {
    vi.setSystemTime(SUNDAY);
    seedDrive({ id: "a", reconciledCount: 5, changesPageToken: "old" });
    countItems.mockResolvedValue(424_242);
    startToken.mockResolvedValue("fresh-token");

    await runReconciliationJob(insertReconcileJob());

    const d = drive("a");
    expect(countItems).toHaveBeenCalled();
    expect(d.reconciled_count).toBe(424_242);
    expect(d.changes_page_token).toBe("fresh-token");
    expect(d.last_full_reconcile_at).not.toBeNull();
  });

  it("a drive with no token does a full count even on a weekday", async () => {
    vi.setSystemTime(WEDNESDAY);
    seedDrive({ id: "a", reconciledCount: 0, changesPageToken: null });
    countItems.mockResolvedValue(10);
    startToken.mockResolvedValue("tok");

    await runReconciliationJob(insertReconcileJob());

    expect(countItems).toHaveBeenCalledTimes(1);
    expect(drive("a").reconciled_count).toBe(10);
  });
});

describe("runReconciliationJob — health + thresholds", () => {
  it("flips a drive to unreachable and emits an error event on Drive failure", async () => {
    vi.setSystemTime(WEDNESDAY);
    seedDrive({ id: "a", reconciledCount: 1, changesPageToken: "t" });
    getMeta.mockRejectedValue(new Error("403 insufficient permissions"));

    await runReconciliationJob(insertReconcileJob());

    expect(drive("a").status).toBe("unreachable");
    expect(events("drive_unreachable")).toHaveLength(1);
    expect(delta).not.toHaveBeenCalled();
  });

  it("auto-flips to read-only and alerts when a drive crosses the stop threshold", async () => {
    vi.setSystemTime(SUNDAY);
    seedDrive({ id: "a", reconciledCount: 0, itemCap: 100_000, changesPageToken: null });
    countItems.mockResolvedValue(96_000); // 96% ≥ 95% stop
    startToken.mockResolvedValue("tok");

    await runReconciliationJob(insertReconcileJob());

    expect(drive("a").status).toBe("read-only");
    expect(events("drive_full_readonly")).toHaveLength(1);
  });

  it("emits a soft-threshold warning between 75% and 85%", async () => {
    vi.setSystemTime(SUNDAY);
    seedDrive({ id: "a", reconciledCount: 0, itemCap: 100_000, changesPageToken: null });
    countItems.mockResolvedValue(78_000); // 78%
    startToken.mockResolvedValue("tok");

    await runReconciliationJob(insertReconcileJob());

    expect(drive("a").status).toBe("active");
    expect(events("drive_threshold_soft")).toHaveLength(1);
  });

  it("emits a drift warning on a large unexpected jump", async () => {
    vi.setSystemTime(WEDNESDAY);
    seedDrive({ id: "a", reconciledCount: 100_000, changesPageToken: "t" });
    delta.mockResolvedValue({ delta: 50_000, newStartPageToken: "t2" }); // +50%
    await runReconciliationJob(insertReconcileJob());
    expect(events("drive_count_drift")).toHaveLength(1);
  });
});

describe("runReconciliationJob — reservation absorption", () => {
  it("releases pre-scan reservations and keeps the count from the Drive API", async () => {
    vi.setSystemTime(SUNDAY);
    seedDrive({
      id: "a",
      reconciledCount: 0,
      pendingReservationsCount: 40_000,
      changesPageToken: null,
    });
    // An open reservation created before the scan.
    testDbRef.current
      .insert(schema.sharedDriveReservations)
      .values({ id: "r1", sharedDriveId: "a", quota: 40_000 })
      .run();
    countItems.mockResolvedValue(40_000); // folder got created → now counted
    startToken.mockResolvedValue("tok");

    await runReconciliationJob(insertReconcileJob());

    const d = drive("a");
    expect(d.reconciled_count).toBe(40_000);
    expect(d.pending_reservations_count).toBe(0);
    const [res] = testDbRef.current.all(
      sql`SELECT released_at FROM shared_drive_reservations WHERE id = 'r1'`,
    ) as { released_at: string | null }[];
    expect(res.released_at).not.toBeNull();
  });
});
