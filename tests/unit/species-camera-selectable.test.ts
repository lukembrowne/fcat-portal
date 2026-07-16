/**
 * U2 — `camera_selectable` flag on the shared species table.
 *
 * getSpeciesList() feeds the camera-trap annotation picker and must exclude
 * audio-only birds (camera_selectable = 0) so the imported BirdNET taxonomy
 * never floods the dropdown — while the manage page (includeNonSelectable)
 * still sees them to promote them. Name/IUCN resolution joins the full table
 * and is unaffected.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
  type TestDb,
} from "../helpers/test-db";
import {
  setupAuthMocks,
  mockRequirePermission,
  testUser,
} from "../helpers/mock-auth";

setupIntegrationDbMock();
setupAuthMocks();

const { getSpeciesList } = await import("@/app/camera-trap/actions");

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;
  mockRequirePermission.mockResolvedValue(testUser);

  db.insert(schema.species)
    .values([
      { scientificName: "Panthera onca", commonName: "Jaguar", type: "mammal", cameraSelectable: true },
      { scientificName: "Cuniculus paca", commonName: "Lowland paca", type: "mammal", cameraSelectable: true },
      // Audio-only bird imported from the BirdNET taxonomy.
      { scientificName: "Adelomyia melanogenys", commonName: "Speckled Hummingbird", type: "bird", cameraSelectable: false },
    ])
    .run();
});

describe("getSpeciesList — camera_selectable filter", () => {
  it("excludes camera_selectable=false species by default (annotation picker)", async () => {
    const rows = await getSpeciesList();
    const names = rows.map((r) => r.scientificName);
    expect(names).toContain("Panthera onca");
    expect(names).toContain("Cuniculus paca");
    expect(names).not.toContain("Adelomyia melanogenys");
  });

  it("includes flagged-out species when includeNonSelectable is set (manage page)", async () => {
    const rows = await getSpeciesList({ includeNonSelectable: true });
    const names = rows.map((r) => r.scientificName);
    expect(names).toContain("Adelomyia melanogenys");
    expect(names).toHaveLength(3);
  });

  it("keeps existing curated species selectable (default flag)", async () => {
    const rows = await getSpeciesList();
    // Both mammals default to selectable; only the audio bird was flagged out.
    expect(rows).toHaveLength(2);
  });
});
