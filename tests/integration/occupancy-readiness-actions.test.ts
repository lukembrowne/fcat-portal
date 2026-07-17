/**
 * U4: getOccupancyReadinessSnapshot (read-only) + refreshOccupancyReadiness
 * (editor+). The read action never runs the heavy recompute; refresh writes a
 * snapshot and clears staleness; a later data change flips stale back on.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, testDbRef, setupIntegrationDbMock, type TestDb } from "../helpers/test-db";
import { setupAuthMocks, mockRequirePermission, testUser } from "../helpers/mock-auth";

setupAuthMocks();
setupIntegrationDbMock();

import {
  getOccupancyReadinessSnapshot,
  refreshOccupancyReadiness,
} from "@/app/ocupacion/actions";

let db: TestDb;
let biochocoId: number;

function seedDeployment(name: string): number {
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
      excludedCamera: false,
    })
    .returning()
    .all();
  return d.id;
}

describe("occupancy readiness snapshot actions (U4)", () => {
  beforeEach(() => {
    db = createTestDb();
    testDbRef.current = db;
    mockRequirePermission.mockReset();
    mockRequirePermission.mockResolvedValue(testUser);
    const [biochoco] = db.insert(schema.cameraTrapProjects).values({ name: "BioChoco" }).returning().all();
    biochocoId = biochoco.id;
    seedDeployment("SITE-1");
  });

  it("cold start: returns null snapshot, not stale", async () => {
    const res = await getOccupancyReadinessSnapshot();
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.snapshot).toBeNull();
    expect(res.data.stale).toBe(false);
    expect(res.data.generatedAt).toBeNull();
  });

  it("refresh writes a snapshot; snapshot then loads and is not stale", async () => {
    const refreshed = await refreshOccupancyReadiness();
    expect(refreshed.success).toBe(true);
    if (!refreshed.success) return;
    expect(refreshed.data.camera).toBeDefined();
    expect(refreshed.data.audio).toBeDefined();

    const rows = db.select().from(schema.occupancyReadinessSnapshots).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].generatedBy).toBe(testUser.email);

    const view = await getOccupancyReadinessSnapshot();
    expect(view.success).toBe(true);
    if (!view.success) return;
    expect(view.data.snapshot).not.toBeNull();
    expect(view.data.stale).toBe(false);
    expect(view.data.generatedBy).toBe(testUser.email);
  });

  it("becomes stale after a new verified deployment lands", async () => {
    await refreshOccupancyReadiness();
    let view = await getOccupancyReadinessSnapshot();
    expect(view.success && view.data.stale).toBe(false);

    seedDeployment("SITE-2");
    view = await getOccupancyReadinessSnapshot();
    expect(view.success && view.data.stale).toBe(true);
    // The snapshot itself is still returned (not dropped) while stale.
    expect(view.success && view.data.snapshot).not.toBeNull();
  });

  it("records a system event on refresh", async () => {
    await refreshOccupancyReadiness();
    const events = db.select().from(schema.systemEvents).all();
    expect(events.some((e) => e.eventType === "occupancy_readiness.refreshed")).toBe(true);
  });

  it("refresh propagates the permission redirect for non-editors", async () => {
    mockRequirePermission.mockRejectedValueOnce(new Error("REDIRECT:/"));
    await expect(refreshOccupancyReadiness()).rejects.toThrow("REDIRECT:/");
    // Nothing was written.
    expect(db.select().from(schema.occupancyReadinessSnapshots).all()).toHaveLength(0);
  });
});
