/**
 * Per-species photo curation + gallery resolution (finca pages).
 *
 * Integration tests against a real in-memory SQLite, covering:
 *  - fetchSpeciesGalleryImages: starred photos win; else all when few; else a
 *    capped highest-confidence sample when many;
 *  - toggleSpeciesPhotoStar: flips starred for an in-scope image; rejects an
 *    image outside the site's token snapshot (cross-site guard).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
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

const { fetchSpeciesGalleryImages, toggleSpeciesPhotoStar } = await import(
  "../actions"
);

let db: TestDb;
let depA: number;
let depB: number;

const SPECIES = "Cuniculus paca";

/** Insert one image + a verified identification of SPECIES, return image id. */
function addImage(opts: {
  deploymentId: number;
  filename: string;
  confidence: number;
  starred?: boolean;
  starredAt?: Date | null;
}): number {
  const [img] = db
    .insert(schema.images)
    .values({
      deploymentId: opts.deploymentId,
      filename: opts.filename,
      status: "processed",
      starred: opts.starred ?? false,
      starredAt: opts.starredAt ?? null,
    })
    .returning()
    .all();
  const [det] = db
    .insert(schema.detections)
    .values({
      imageId: img.id,
      bboxX: 0,
      bboxY: 0,
      bboxWidth: 1,
      bboxHeight: 1,
      detectionConfidence: opts.confidence,
    })
    .returning()
    .all();
  db.insert(schema.identifications)
    .values({
      detectionId: det.id,
      species: SPECIES,
      confidence: opts.confidence,
      verificationStatus: "verified",
    })
    .run();
  return img.id;
}

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;
  mockRequirePermission.mockResolvedValue(testUser);

  const deps = db
    .insert(schema.deployments)
    .values([
      { projectId: "camera-trap", name: "TST-001_V1", status: "processed" },
      { projectId: "camera-trap", name: "OTHER-001_V1", status: "processed" },
    ])
    .returning()
    .all();
  depA = deps[0].id;
  depB = deps[1].id;

  db.insert(schema.siteShareTokens)
    .values({
      token: "11111111-1111-4111-8111-111111111111",
      biochocoSiteId: "TST-001",
      deploymentIds: JSON.stringify([depA]),
      createdBy: "test@fcat-ecuador.org",
    })
    .run();
});

describe("fetchSpeciesGalleryImages", () => {
  it("returns only starred photos when any are starred", async () => {
    addImage({ deploymentId: depA, filename: "s1.jpg", confidence: 0.5, starred: true, starredAt: new Date(1000) });
    addImage({ deploymentId: depA, filename: "s2.jpg", confidence: 0.5, starred: true, starredAt: new Date(2000) });
    for (let i = 0; i < 30; i++) {
      addImage({ deploymentId: depA, filename: `plain${i}.jpg`, confidence: 0.5 });
    }

    const res = await fetchSpeciesGalleryImages([depA], SPECIES, 1, 50);
    expect(res.mode).toBe("starred");
    expect(res.totalCount).toBe(2);
    expect(res.totalAvailable).toBe(32);
    expect(res.images.map((i) => i.filename).sort()).toEqual(["s1.jpg", "s2.jpg"]);
  });

  it("returns all photos when none starred and count ≤ threshold", async () => {
    for (let i = 0; i < 7; i++) {
      addImage({ deploymentId: depA, filename: `p${i}.jpg`, confidence: 0.5 });
    }
    const res = await fetchSpeciesGalleryImages([depA], SPECIES, 1, 50);
    expect(res.mode).toBe("all");
    expect(res.totalCount).toBe(7);
    expect(res.images).toHaveLength(7);
  });

  it("caps to the highest-confidence sample when none starred and count > threshold", async () => {
    // 20 low-confidence + 6 high-confidence — the 6 high ones should survive.
    for (let i = 0; i < 20; i++) {
      addImage({ deploymentId: depA, filename: `low${i}.jpg`, confidence: 0.1 });
    }
    const highIds = new Set<number>();
    for (let i = 0; i < 6; i++) {
      highIds.add(addImage({ deploymentId: depA, filename: `high${i}.jpg`, confidence: 0.9 }));
    }
    const res = await fetchSpeciesGalleryImages([depA], SPECIES, 1, 50);
    expect(res.mode).toBe("capped");
    expect(res.totalCount).toBe(6);
    expect(res.totalAvailable).toBe(26);
    expect(res.images.every((i) => highIds.has(i.id))).toBe(true);
  });

  it("excludes another site's images (deployment scope)", async () => {
    addImage({ deploymentId: depA, filename: "mine.jpg", confidence: 0.5 });
    addImage({ deploymentId: depB, filename: "theirs.jpg", confidence: 0.5 });
    const res = await fetchSpeciesGalleryImages([depA], SPECIES, 1, 50);
    expect(res.images.map((i) => i.filename)).toEqual(["mine.jpg"]);
  });
});

describe("toggleSpeciesPhotoStar", () => {
  it("stars and unstars an in-scope image", async () => {
    const id = addImage({ deploymentId: depA, filename: "x.jpg", confidence: 0.5 });

    const on = await toggleSpeciesPhotoStar("TST-001", id);
    expect(on.success && on.data.starred).toBe(true);
    let row = db.select().from(schema.images).where(eq(schema.images.id, id)).get();
    expect(row?.starred).toBe(true);
    expect(row?.starredBy).toBe(testUser.email);

    const off = await toggleSpeciesPhotoStar("TST-001", id);
    expect(off.success && off.data.starred).toBe(false);
    row = db.select().from(schema.images).where(eq(schema.images.id, id)).get();
    expect(row?.starred).toBe(false);
    expect(row?.starredBy).toBeNull();
  });

  it("rejects an image outside the site's token snapshot (cross-site guard)", async () => {
    const foreignId = addImage({ deploymentId: depB, filename: "foreign.jpg", confidence: 0.5 });
    const res = await toggleSpeciesPhotoStar("TST-001", foreignId);
    expect(res.success).toBe(false);
    const row = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.id, foreignId))
      .get();
    expect(row?.starred).toBe(false); // untouched
  });
});
