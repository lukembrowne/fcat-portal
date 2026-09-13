/**
 * Training exports can be scoped to a subset of camera-trap projects, so a
 * project whose verification is still half-done (Historical, mid-review) can be
 * kept out of a dataset without excluding its cameras globally.
 *
 * These tests exercise the SQL side of that filter — the part that decides
 * which detections are candidates at all. The crop-writing path is unchanged by
 * the filter and is not re-tested here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
  type TestDb,
} from "../helpers/test-db";
import {
  setupAuthMocks,
  mockRequireAdmin,
  testAdmin,
} from "../helpers/mock-auth";
import {
  EXTERNAL_SOURCE_KEY,
  UNASSIGNED_SOURCE_KEY,
} from "@/lib/training-export-helpers";

setupIntegrationDbMock();
setupAuthMocks();

import {
  listExportSources,
  getExportPreview,
  exportTrainingDataset,
} from "@/app/camera-trap/training-exports/actions";

let db: TestDb;
let bioProjectId: number;
let histProjectId: number;

/** A deployment with `count` verified detections of `species`, one per image. */
function seedDeployment(opts: {
  name: string;
  ctProjectId: number | null;
  isExternal?: boolean;
  species: string;
  count: number;
}): number {
  const [d] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: opts.name,
      status: "verified",
      cameraTrapProjectId: opts.ctProjectId,
      isExternal: opts.isExternal ?? false,
      excludedCamera: false,
    })
    .returning()
    .all();

  for (let i = 0; i < opts.count; i++) {
    const [img] = db
      .insert(schema.images)
      .values({
        deploymentId: d.id,
        filename: `${opts.name}-${i}.jpg`,
        status: "processed",
        // Every candidate needs a durable fetch route: a Drive id for FCAT
        // rows, a local path for external ones.
        driveFileId: opts.isExternal ? null : `drive-${opts.name}-${i}`,
        path: opts.isExternal ? `/data/external/${opts.name}-${i}.jpg` : null,
        isExternal: opts.isExternal ?? false,
      })
      .returning()
      .all();
    const [det] = db
      .insert(schema.detections)
      .values({
        imageId: img.id,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.5,
        bboxHeight: 0.5,
        detectionConfidence: 0.9,
        detectionClass: 0,
        modelVersion: "test-v1",
      })
      .returning()
      .all();
    db.insert(schema.identifications)
      .values({
        detectionId: det.id,
        species: opts.species,
        confidence: 0.9,
        modelVersion: "test-v1",
        verificationStatus: "verified",
      })
      .run();
  }
  return d.id;
}

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;
  mockRequireAdmin.mockResolvedValue(testAdmin);

  const [bio] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "BioChoco" })
    .returning()
    .all();
  const [hist] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "Historical" })
    .returning()
    .all();
  bioProjectId = bio.id;
  histProjectId = hist.id;

  // Three deployments per project so a class can clear the ≥3-deployment
  // coverage rule inside one project on its own.
  for (let i = 1; i <= 3; i++) {
    seedDeployment({
      name: `BIO-00${i}`,
      ctProjectId: bioProjectId,
      species: "Dasyprocta punctata",
      count: 4,
    });
    seedDeployment({
      name: `HIST-00${i}`,
      ctProjectId: histProjectId,
      species: "Leopardus pardalis",
      count: 4,
    });
  }
});

describe("listExportSources", () => {
  it("reports one row per project with its verified material", async () => {
    const res = await listExportSources();
    expect(res.success).toBe(true);
    if (!res.success) return;
    const byName = new Map(res.data.map((s) => [s.name, s]));
    expect(byName.get("BioChoco")).toMatchObject({
      key: String(bioProjectId),
      detections: 12,
      deployments: 3,
      isExternal: false,
    });
    expect(byName.get("Historical")).toMatchObject({
      key: String(histProjectId),
      detections: 12,
      deployments: 3,
    });
  });

  it("lists LILA deployments as their own source, not under a project", async () => {
    seedDeployment({
      name: "LILA: WCS",
      ctProjectId: null,
      isExternal: true,
      species: "Dasyprocta punctata",
      count: 5,
    });
    const res = await listExportSources();
    expect(res.success).toBe(true);
    if (!res.success) return;
    const external = res.data.find((s) => s.key === EXTERNAL_SOURCE_KEY);
    expect(external).toMatchObject({ detections: 5, isExternal: true });
  });

  it("lists project-less FCAT deployments under the unassigned bucket", async () => {
    seedDeployment({
      name: "ORPHAN-001",
      ctProjectId: null,
      species: "Dasyprocta punctata",
      count: 6,
    });
    const res = await listExportSources();
    expect(res.success).toBe(true);
    if (!res.success) return;
    const orphan = res.data.find((s) => s.key === UNASSIGNED_SOURCE_KEY);
    expect(orphan).toMatchObject({ detections: 6, isExternal: false });
  });

  it("omits projects that have nothing verified — an empty choice is not a choice", async () => {
    db.insert(schema.cameraTrapProjects).values({ name: "Vacío" }).run();
    const res = await listExportSources();
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.map((s) => s.name)).not.toContain("Vacío");
  });
});

describe("getExportPreview — corpus scope", () => {
  it("draws from every source when no selection is given", async () => {
    const res = await getExportPreview(4, 0.1, null);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.totalCandidates).toBe(24);
    expect(res.data.classList.sort()).toEqual([
      "Dasyprocta punctata",
      "Leopardus pardalis",
    ]);
  });

  it("drops the unselected project's detections AND its classes", async () => {
    const res = await getExportPreview(4, 0.1, [String(bioProjectId)]);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.totalCandidates).toBe(12);
    expect(res.data.classList).toEqual(["Dasyprocta punctata"]);
    expect(res.data.deploymentCount).toBe(3);
  });

  it("reports what each selected source actually contributed", async () => {
    const res = await getExportPreview(4, 0.1, null);
    expect(res.success).toBe(true);
    if (!res.success) return;
    const byName = new Map(res.data.perSource.map((s) => [s.name, s.imageCount]));
    expect(byName.get("BioChoco")).toBe(12);
    expect(byName.get("Historical")).toBe(12);
  });

  it("selecting projects does NOT sweep in LILA rows, which have no project", async () => {
    seedDeployment({
      name: "LILA: WCS",
      ctProjectId: null,
      isExternal: true,
      species: "Dasyprocta punctata",
      count: 5,
    });
    const withExternal = await getExportPreview(4, 0.1, null);
    expect(withExternal.success).toBe(true);
    if (!withExternal.success) return;
    expect(withExternal.data.totalCandidates).toBe(29);

    const projectsOnly = await getExportPreview(4, 0.1, [
      String(bioProjectId),
      String(histProjectId),
    ]);
    expect(projectsOnly.success).toBe(true);
    if (!projectsOnly.success) return;
    expect(projectsOnly.data.totalCandidates).toBe(24);
  });

  it("selecting the unassigned bucket does NOT sweep in LILA rows either", async () => {
    seedDeployment({
      name: "LILA: WCS",
      ctProjectId: null,
      isExternal: true,
      species: "Dasyprocta punctata",
      count: 5,
    });
    seedDeployment({
      name: "ORPHAN-001",
      ctProjectId: null,
      species: "Dasyprocta punctata",
      count: 6,
    });
    const res = await getExportPreview(1, 0.1, [UNASSIGNED_SOURCE_KEY]);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.totalCandidates).toBe(6);
  });

  it("refuses an empty selection instead of reading it as everything", async () => {
    const res = await getExportPreview(4, 0.1, []);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/al menos un proyecto/i);
  });

  it("treats an unknown source key as selecting nothing, never everything", async () => {
    const res = await getExportPreview(4, 0.1, ["999999"]);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.totalCandidates).toBe(0);
  });
});

describe("exportTrainingDataset — corpus scope", () => {
  it("refuses a present-but-empty selection rather than exporting everything", async () => {
    // What the form submits when the admin unticks every box. It must not be
    // indistinguishable from an absent field, which means "no filter".
    const fd = new FormData();
    fd.set("minExamples", "4");
    fd.append("sourceKeys", "");
    const res = await exportTrainingDataset(fd);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/al menos un proyecto/i);
  });

  it("names the selection when the chosen projects have nothing verified", async () => {
    const [empty] = db
      .insert(schema.cameraTrapProjects)
      .values({ name: "Vacío" })
      .returning()
      .all();
    const fd = new FormData();
    fd.set("minExamples", "4");
    fd.append("sourceKeys", String(empty.id));
    const res = await exportTrainingDataset(fd);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/proyectos seleccionados/i);
  });
});

/**
 * A split-strategy migration clears EVERY deployment's persisted split and
 * re-stratifies from scratch. Run under a filter it would clear splits it then
 * never reassigns, and the next full export would read the bumped manifest,
 * conclude no migration is pending, and anchor to that damage. So the two are
 * mutually exclusive, and the filtered one is the one that has to wait.
 */
describe("getExportPreview — pending split migration", () => {
  beforeEach(() => {
    // No dataset rows + an already-persisted split is exactly what
    // needsSplitStrategyMigration reads as "assigned by older code".
    db.update(schema.deployments)
      .set({ trainingSplit: "train" })
      .where(eq(schema.deployments.name, "BIO-001"))
      .run();
  });

  it("refuses a filtered preview and says to run a full export first", async () => {
    const res = await getExportPreview(4, 0.1, [String(bioProjectId)]);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/todos los proyectos/i);
  });

  it("still allows the unfiltered preview, which is what clears the migration", async () => {
    const res = await getExportPreview(4, 0.1, null);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.migrationApplied).toBe(true);
  });
});
