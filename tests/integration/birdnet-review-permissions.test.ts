/**
 * The permission boundary of the validation module, asserted per action.
 *
 * Reviewing is the ONE write a `viewer` on `grabaciones` may perform. That
 * split exists because the people with the ears — students, visiting
 * taxonomists — are exactly the people who should not hold `editor`, which on
 * this project also carries `deleteAudioDetection`, `bulkUpdateAudioMetadata`
 * and `cancelBirdNETJob`. See `recordReview` for the full reasoning.
 *
 * These assertions read the ROLE each action asks for, not whether a call
 * succeeds, because `requirePermission` runs before any other work: the
 * arguments are observable even when the action then fails for its own
 * reasons. A role that drifts is caught here rather than in production, where
 * the symptom is either a student who cannot work or a student who can delete.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { mockRequirePermission, setupAuthMocks, testUser } from "../helpers/mock-auth";
import {
  createTestDb,
  setupIntegrationDbMock,
  testDbRef,
  type TestDb,
} from "../helpers/test-db";

setupAuthMocks();
setupIntegrationDbMock();

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/habitat-lookup", () => ({
  loadSiteHabitatMap: async () => new Map<string, string>(),
}));
vi.mock("@/lib/camera-trap-auth", () => ({
  getUserCameraTrapProjects: vi.fn(async () => "all"),
}));

let db: TestDb;

/** The role the action asked for, from the single `requirePermission` call. */
function roleRequested(): string {
  expect(mockRequirePermission).toHaveBeenCalled();
  const [projectId, role] = mockRequirePermission.mock.calls[0] as [string, string];
  expect(projectId).toBe("grabaciones");
  return role;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue(testUser);
  db = createTestDb();
  testDbRef.current = db;
});

describe("reviewing is open to a viewer", () => {
  it("loads the review queue at viewer level", async () => {
    const { getReviewQueue } = await import("@/app/audio/validacion/actions");
    await getReviewQueue(1, 5);
    expect(roleRequested()).toBe("viewer");
  });

  it("records a review at viewer level", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    await recordReview(1, "correct");
    expect(roleRequested()).toBe("viewer");
  });

  it("reads progress and agreement at viewer level", async () => {
    const { getCampaignProgress } = await import("@/app/audio/validacion/actions");
    await getCampaignProgress(1);
    expect(roleRequested()).toBe("viewer");
  });
});

describe("everything that ends a species, or changes what the portal filters, stays editor", () => {
  // Each of these either destroys review work, decides whose reviews the fit
  // reads, or rewrites every species count and occupancy input in the portal.
  // A viewer must reach none of them.
  const guarded: Array<[string, (m: Record<string, any>) => Promise<unknown>]> = [
    ["createCampaign", (m) => m.createCampaign({ species: "Tringa flavipes" })],
    ["drawSample", (m) => m.drawSample(1)],
    ["deleteCampaign", (m) => m.deleteCampaign(1)],
    ["abandonCampaign", (m) => m.abandonCampaign(1, "no sirve")],
    ["restoreCampaign", (m) => m.restoreCampaign(1)],
    ["setPrimaryReviewer", (m) => m.setPrimaryReviewer(1, "a@b.org")],
    ["removeReviewer", (m) => m.removeReviewer(1, "a@b.org")],
    ["runFit", (m) => m.runFit(1)],
    ["applyThreshold", (m) => m.applyThreshold(1)],
    ["markSpeciesNoFilter", (m) => m.markSpeciesNoFilter(1)],
    ["revertThreshold", (m) => m.revertThreshold(1)],
  ];

  for (const [name, call] of guarded) {
    it(`${name} requires editor`, async () => {
      const actions = await import("@/app/audio/validacion/actions");
      await call(actions as unknown as Record<string, any>).catch(() => {});
      expect(roleRequested()).toBe("editor");
    });
  }
});

describe("a viewer's answer cannot displace a colleague's", () => {
  it("keys reviews per reviewer", () => {
    // The guarantee that makes viewer-level review safe is in the schema, not
    // in the action: one row per (sample, reviewer), so the worst a reviewer
    // can do to someone else's work is nothing.
    const indexes = db
      .all<{ sql: string | null }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index'
           AND tbl_name = 'birdnet_validation_reviews'`
      )
      .map((r) => (r.sql ?? "").toLowerCase());

    expect(
      indexes.some(
        (sql) =>
          sql.includes("unique") &&
          sql.includes("sample_id") &&
          sql.includes("reviewer_email")
      )
    ).toBe(true);
  });
});
