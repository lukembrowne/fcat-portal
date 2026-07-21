/**
 * U3 — fetchSiteStarredPhotoOptions: the featured-photos picker's default
 * source. Returns the site's STARRED images, scoped to the active token's
 * deployment snapshot, ordered by when they were starred.
 *
 * Integration test against a real in-memory SQLite (same gate + query the
 * action runs in prod), covering:
 *  - only starred images in the token snapshot are returned;
 *  - a starred image in ANOTHER site's deployment is excluded (cross-site gate);
 *  - unstarred images are excluded;
 *  - results are ordered by starredAt (not insertion / id order);
 *  - a site whose snapshot has no starred images returns [] — the empty shape
 *    that tells the builder to fall back to the "Todas" filter.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
  type TestDb,
} from "../../../../../tests/helpers/test-db";
import {
  setupAuthMocks,
  mockRequirePermission,
  testUser,
} from "../../../../../tests/helpers/mock-auth";

setupIntegrationDbMock();
setupAuthMocks();

const { fetchSiteStarredPhotoOptions } = await import("../actions");

let db: TestDb;
let depA: number;
let depB: number;
let depC: number;

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;
  mockRequirePermission.mockResolvedValue(testUser);

  const deps = db
    .insert(schema.deployments)
    .values([
      { projectId: "camera-trap", name: "TST-001_V1", status: "processed" },
      { projectId: "camera-trap", name: "OTHER-001_V1", status: "processed" },
      { projectId: "camera-trap", name: "TST-EMPTY_V1", status: "processed" },
    ])
    .returning()
    .all();
  depA = deps[0].id;
  depB = deps[1].id;
  depC = deps[2].id;

  // Site TST-001 snapshot = [depA]. Starred (out of starredAt order), one
  // unstarred, plus a starred image in depB that belongs to another site.
  db.insert(schema.images)
    .values([
      // starredAt intentionally out of insertion order to prove ORDER BY.
      { deploymentId: depA, filename: "late.jpg", status: "processed", starred: true, starredAt: new Date(3000_000) },
      { deploymentId: depA, filename: "early.jpg", status: "processed", starred: true, starredAt: new Date(1000_000) },
      { deploymentId: depA, filename: "middle.jpg", status: "processed", starred: true, starredAt: new Date(2000_000) },
      { deploymentId: depA, filename: "unstarred.jpg", status: "processed", starred: false },
      // Another site's starred image — must never leak into TST-001.
      { deploymentId: depB, filename: "other-site.jpg", status: "processed", starred: true, starredAt: new Date(500_000) },
      // depC (TST-EMPTY) has only unstarred images.
      { deploymentId: depC, filename: "plain.jpg", status: "processed", starred: false },
    ])
    .run();

  db.insert(schema.siteShareTokens)
    .values([
      {
        token: "11111111-1111-4111-8111-111111111111",
        biochocoSiteId: "TST-001",
        deploymentIds: JSON.stringify([depA]),
        createdBy: "test@fcat-ecuador.org",
      },
      {
        token: "22222222-2222-4222-8222-222222222222",
        biochocoSiteId: "TST-EMPTY",
        deploymentIds: JSON.stringify([depC]),
        createdBy: "test@fcat-ecuador.org",
      },
    ])
    .run();
});

describe("fetchSiteStarredPhotoOptions", () => {
  it("returns only starred images within the token's deployment snapshot", async () => {
    const opts = await fetchSiteStarredPhotoOptions("TST-001");
    const labels = opts.map((o) => o.label);
    expect(labels).toContain("early.jpg");
    expect(labels).toContain("middle.jpg");
    expect(labels).toContain("late.jpg");
    // unstarred + other-site images are excluded.
    expect(labels).not.toContain("unstarred.jpg");
    expect(labels).not.toContain("other-site.jpg");
    expect(opts).toHaveLength(3);
  });

  it("orders results by starredAt (earliest first), not by id", async () => {
    const opts = await fetchSiteStarredPhotoOptions("TST-001");
    expect(opts.map((o) => o.label)).toEqual([
      "early.jpg",
      "middle.jpg",
      "late.jpg",
    ]);
  });

  it("returns [] when the site's snapshot has no starred images (builder → Todas)", async () => {
    const opts = await fetchSiteStarredPhotoOptions("TST-EMPTY");
    expect(opts).toEqual([]);
  });

  it("returns [] when the site has no active share token", async () => {
    const opts = await fetchSiteStarredPhotoOptions("NO-SUCH-SITE");
    expect(opts).toEqual([]);
  });
});
