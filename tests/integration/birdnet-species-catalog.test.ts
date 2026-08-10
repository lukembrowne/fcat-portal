/**
 * Integration tests for `listValidatableSpecies` — the catalog the species
 * picker and the bulk import both read.
 *
 * The invariant under test is that the catalog is derived from what BirdNET
 * actually detected, not from the species lookup table: the lookup table holds
 * the full BirdNET taxonomy (~6k labels) while only a few hundred have ever
 * been detected here, and at least one detected label has no lookup row at all.
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

const mockProjects = vi.fn();
vi.mock("@/lib/camera-trap-auth", () => ({
  getUserCameraTrapProjects: () => mockProjects(),
}));

let db: TestDb;
/** Deployment id per camera-trap project, keyed by project index. */
let deploymentByProject: number[] = [];
let projectIds: number[] = [];

function seedDetections(species: string, count: number, projectIdx = 0) {
  const deploymentId = deploymentByProject[projectIdx];
  for (let i = 0; i < count; i++) {
    const [file] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: `CAT_2026021${projectIdx}_1200${i}0.flac`,
        driveFileId: `drive-${species}-${projectIdx}-${i}`,
        duration: 60,
      })
      .returning()
      .all();
    const [detection] = db
      .insert(schema.audioDetections)
      .values({
        audioFileId: file.id,
        startTime: 10,
        endTime: 13,
        minFreq: 0,
        maxFreq: 15000,
        confidence: 0.5,
      })
      .returning()
      .all();
    db.insert(schema.audioIdentifications)
      .values({ audioDetectionId: detection.id, species, confidence: 0.5 })
      .run();
  }
}

async function catalog() {
  const { listValidatableSpecies } = await import("@/app/audio/validacion/actions");
  const result = await listValidatableSpecies();
  if (!result.success) throw new Error(result.error);
  return result.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue(testUser);
  mockProjects.mockResolvedValue("all");

  db = createTestDb();
  testDbRef.current = db;
  deploymentByProject = [];
  projectIds = [];

  for (let i = 0; i < 2; i++) {
    const [ctProject] = db
      .insert(schema.cameraTrapProjects)
      .values({ name: `CatalogProject${i}` })
      .returning()
      .all();
    projectIds.push(ctProject.id);

    const [deployment] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: `CAT-00${i}`,
        siteName: `CAT-00${i}`,
        status: "scanned",
        cameraTrapProjectId: ctProject.id,
      })
      .returning()
      .all();
    deploymentByProject.push(deployment.id);
  }
});

describe("listValidatableSpecies", () => {
  it("returns one row per distinct species, not one per detection", async () => {
    seedDetections("Ramphastos ambiguus", 5);
    seedDetections("Cebus aequatorialis", 3);

    const rows = await catalog();

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.scientificName)).toEqual([
      "Cebus aequatorialis",
      "Ramphastos ambiguus",
    ]);
  });

  it("counts detections per species", async () => {
    seedDetections("Ramphastos ambiguus", 5);
    seedDetections("Cebus aequatorialis", 3);

    const rows = await catalog();

    expect(rows.find((r) => r.scientificName === "Ramphastos ambiguus")!.detectionCount).toBe(5);
    expect(rows.find((r) => r.scientificName === "Cebus aequatorialis")!.detectionCount).toBe(3);
  });

  it("carries both display names when the species has a lookup row", async () => {
    db.insert(schema.species)
      .values({
        scientificName: "Ramphastos ambiguus",
        commonName: "Yellow-throated Toucan",
        spanishName: "Tucán del Chocó",
        type: "bird",
      })
      .run();
    seedDetections("Ramphastos ambiguus", 2);

    const [row] = await catalog();

    expect(row.commonName).toBe("Yellow-throated Toucan");
    expect(row.spanishName).toBe("Tucán del Chocó");
  });

  it("still lists a detected species with no lookup-table row", async () => {
    // Real case: 1 of 554 detected labels has no `biochoco_species` row. An
    // inner join here would silently drop it from the picker.
    seedDetections("Mystery labelus", 4);

    const rows = await catalog();

    expect(rows).toHaveLength(1);
    expect(rows[0].scientificName).toBe("Mystery labelus");
    expect(rows[0].commonName).toBeNull();
    expect(rows[0].spanishName).toBeNull();
    expect(rows[0].detectionCount).toBe(4);
  });

  it("flags a species that already has an active validation", async () => {
    seedDetections("Ramphastos ambiguus", 2);
    const { createCampaign } = await import("@/app/audio/validacion/actions");
    await createCampaign({ species: "Ramphastos ambiguus" });

    const [row] = await catalog();

    // Creating the species draws its sample, so it is past draft immediately.
    expect(row.activeStatus).toBe("sampled");
  });

  it("does not flag a species whose only validation was abandoned", async () => {
    seedDetections("Ramphastos ambiguus", 2);
    const { createCampaign, abandonCampaign } = await import(
      "@/app/audio/validacion/actions"
    );
    const created = await createCampaign({ species: "Ramphastos ambiguus" });
    if (!created.success) throw new Error(created.error);
    await abandonCampaign(created.data.campaignId, "prueba");

    const [row] = await catalog();

    expect(row.activeStatus).toBeNull();
  });

  it("excludes detections from projects the caller cannot access", async () => {
    seedDetections("Ramphastos ambiguus", 5, 0);
    seedDetections("Ramphastos ambiguus", 7, 1);
    mockProjects.mockResolvedValue([projectIds[0]]);

    const [row] = await catalog();

    expect(row.detectionCount).toBe(5);
  });

  it("returns nothing when the caller has access to no projects", async () => {
    seedDetections("Ramphastos ambiguus", 5, 0);
    mockProjects.mockResolvedValue([]);

    expect(await catalog()).toEqual([]);
  });

  it("returns an empty array rather than an error when nothing is detected", async () => {
    expect(await catalog()).toEqual([]);
  });
});
