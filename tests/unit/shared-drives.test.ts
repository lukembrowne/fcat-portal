import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  createSharedDrivesTestDb,
  testDbRef,
  setupIntegrationDbMock,
} from "../helpers/test-db";

setupIntegrationDbMock();

const mod = await import("@/lib/shared-drives");
const {
  selectAndReserveSlot,
  releaseReservation,
  getDriveStatus,
  getDriveRootIdsForProject,
  DEPLOYMENT_QUOTA,
  DRIVE_ID_REGEX,
  sanitizeDriveError,
} = mod;

// Default project for seeded drives (one-project-per-drive). Tests that need
// multiple projects override `cameraTrapProjectId`.
const PROJECT = 1;

type DriveSeed = {
  id: string;
  driveId?: string;
  rootFolderId?: string;
  cameraTrapProjectId?: number;
  status?: schema.SharedDriveStatus;
  reconciledCount?: number;
  pendingReservationsCount?: number;
  itemCap?: number;
  archivedAt?: string | null;
};

function seedDrive(s: DriveSeed) {
  testDbRef.current
    .insert(schema.sharedDrives)
    .values({
      id: s.id,
      driveId: s.driveId ?? `0A${s.id.padEnd(16, "x")}`,
      rootFolderId: s.rootFolderId ?? `root-${s.id}`,
      name: s.id,
      cameraTrapProjectId: s.cameraTrapProjectId ?? PROJECT,
      status: s.status ?? "active",
      reconciledCount: s.reconciledCount ?? 0,
      pendingReservationsCount: s.pendingReservationsCount ?? 0,
      itemCap: s.itemCap ?? 500_000,
      archivedAt: s.archivedAt ?? null,
    })
    .run();
}

function pending(id: string): number {
  const row = testDbRef.current.get(
    sql`SELECT pending_reservations_count AS p FROM shared_drives WHERE id = ${id}`,
  ) as { p: number };
  return row.p;
}

function openReservations(): number {
  const row = testDbRef.current.get(
    sql`SELECT COUNT(*) AS n FROM shared_drive_reservations WHERE released_at IS NULL`,
  ) as { n: number };
  return row.n;
}

beforeEach(() => {
  vi.clearAllMocks();
  testDbRef.current = createSharedDrivesTestDb();
});

describe("DRIVE_ID_REGEX", () => {
  it("accepts a plausible Shared Drive ID and rejects folder IDs / junk", () => {
    expect(DRIVE_ID_REGEX.test("0AItvDf3Hk9aLUk9PVA")).toBe(true);
    expect(DRIVE_ID_REGEX.test("1AItvDf3Hk9aLUk9PVA")).toBe(false); // folder-ish
    expect(DRIVE_ID_REGEX.test("0A")).toBe(false); // too short
    expect(DRIVE_ID_REGEX.test("not an id")).toBe(false);
  });
});

describe("selectAndReserveSlot", () => {
  it("returns no_active_drives when the registry is empty", () => {
    expect(selectAndReserveSlot(PROJECT)).toEqual({ error: "no_active_drives" });
  });

  it("returns no_active_drives when only non-active / archived drives exist", () => {
    seedDrive({ id: "a", status: "read-only" });
    seedDrive({ id: "b", status: "registering" });
    seedDrive({ id: "c", status: "active", archivedAt: "2026-05-24 00:00:00" });
    expect(selectAndReserveSlot(PROJECT)).toEqual({ error: "no_active_drives" });
  });

  it("only considers drives belonging to the requested project", () => {
    // An eligible drive on a DIFFERENT project must never be picked.
    seedDrive({ id: "other", cameraTrapProjectId: 2, reconciledCount: 0 });
    expect(selectAndReserveSlot(PROJECT)).toEqual({ error: "no_active_drives" });
    // Once this project has a drive, it's picked — the other stays untouched.
    seedDrive({ id: "mine", cameraTrapProjectId: PROJECT, reconciledCount: 0 });
    const res = selectAndReserveSlot(PROJECT);
    if ("error" in res) throw new Error("expected a pick");
    expect(res.sharedDriveId).toBe("mine");
    expect(pending("other")).toBe(0);
  });

  it("picks the fullest eligible drive and reserves the quota", () => {
    seedDrive({ id: "low", reconciledCount: 10_000 });
    seedDrive({ id: "high", reconciledCount: 200_000 });

    const res = selectAndReserveSlot(PROJECT);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.sharedDriveId).toBe("high");
    expect(res.rootFolderId).toBe("root-high");
    expect(pending("high")).toBe(DEPLOYMENT_QUOTA);
    expect(pending("low")).toBe(0);
    expect(openReservations()).toBe(1);
  });

  it("breaks ties on id ASC", () => {
    seedDrive({ id: "bbb", reconciledCount: 10_000 });
    seedDrive({ id: "aaa", reconciledCount: 10_000 });
    const res = selectAndReserveSlot(PROJECT);
    if ("error" in res) throw new Error("expected a pick");
    expect(res.sharedDriveId).toBe("aaa");
  });

  it("never reserves past the hard threshold (default 85%)", () => {
    // cap 100k → hard 85k. Each reservation = 40k. Two fit (80k), third refused.
    seedDrive({ id: "d", reconciledCount: 0, itemCap: 100_000 });
    expect("error" in selectAndReserveSlot(PROJECT)).toBe(false);
    expect("error" in selectAndReserveSlot(PROJECT)).toBe(false);
    expect(selectAndReserveSlot(PROJECT)).toEqual({ error: "no_capacity" });
    expect(pending("d")).toBe(2 * DEPLOYMENT_QUOTA);
  });

  it("never lets concurrent-style repeated reservations exceed cap*hard", () => {
    seedDrive({ id: "x", itemCap: 500_000 });
    seedDrive({ id: "y", itemCap: 500_000 });
    for (let i = 0; i < 30; i++) selectAndReserveSlot(PROJECT);
    for (const id of ["x", "y"]) {
      const row = testDbRef.current.get(
        sql`SELECT reconciled_count + pending_reservations_count AS eff, item_cap AS cap FROM shared_drives WHERE id = ${id}`,
      ) as { eff: number; cap: number };
      expect(row.eff).toBeLessThanOrEqual(Math.floor(row.cap * 0.85));
    }
  });
});

describe("releaseReservation", () => {
  it("decrements pending and is idempotent by token", () => {
    seedDrive({ id: "d" });
    const res = selectAndReserveSlot(PROJECT);
    if ("error" in res) throw new Error("expected a pick");
    expect(pending("d")).toBe(DEPLOYMENT_QUOTA);

    releaseReservation(res.reservationId);
    expect(pending("d")).toBe(0);
    expect(openReservations()).toBe(0);

    // Second release is a no-op (no negative counter, no throw).
    releaseReservation(res.reservationId);
    expect(pending("d")).toBe(0);
  });

  it("ignores an unknown reservation id", () => {
    seedDrive({ id: "d", pendingReservationsCount: 12345 });
    releaseReservation("does-not-exist");
    expect(pending("d")).toBe(12345);
  });
});

describe("getDriveStatus / getDriveRootIdsForProject", () => {
  it("reads current status and lists a project's non-archived roots", () => {
    seedDrive({ id: "a", status: "active", rootFolderId: "root-a" });
    seedDrive({ id: "b", status: "read-only", rootFolderId: "root-b" });
    seedDrive({ id: "c", status: "active", rootFolderId: "root-c", archivedAt: "2026-05-24 00:00:00" });
    // A drive on another project must be excluded from this project's roots.
    seedDrive({ id: "d", status: "active", rootFolderId: "root-d", cameraTrapProjectId: 2 });

    expect(getDriveStatus("a")).toBe("active");
    expect(getDriveStatus("b")).toBe("read-only");
    expect(getDriveStatus("missing")).toBeNull();

    const roots = getDriveRootIdsForProject(PROJECT).sort();
    expect(roots).toEqual(["root-a", "root-b"]);
    expect(getDriveRootIdsForProject(2)).toEqual(["root-d"]);
  });
});

describe("sanitizeDriveError", () => {
  it("strips id-like substrings and caps length", () => {
    const err = { code: 404, message: "File 0AItvDf3Hk9aLUk9PVAbcdef not found" };
    const out = sanitizeDriveError(err);
    expect(out).toContain("[404]");
    expect(out).not.toContain("0AItvDf3Hk9aLUk9PVAbcdef");
    expect(out).toContain("[id]");
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("selection query plan", () => {
  it("uses the project/status index for the (project-scoped) selection filter", () => {
    for (let i = 0; i < 200; i++) {
      seedDrive({ id: `d${String(i).padStart(3, "0")}`, reconciledCount: i * 100 });
    }
    const plan = testDbRef.current.all(sql`
      EXPLAIN QUERY PLAN
      SELECT id FROM shared_drives
      WHERE status = 'active' AND archived_at IS NULL
        AND camera_trap_project_id = ${PROJECT}
        AND (reconciled_count + pending_reservations_count + 40000) <= (item_cap * 0.85)
      ORDER BY (reconciled_count + pending_reservations_count) DESC, id ASC
      LIMIT 1
    `) as { detail: string }[];
    const joined = plan.map((p) => p.detail).join(" | ");
    expect(joined).toMatch(/idx_shared_drives_project_status/);
  });
});
