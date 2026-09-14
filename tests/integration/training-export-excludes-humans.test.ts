/**
 * Pictures of people never leave the portal in a training dataset.
 *
 * The camera traps photograph the people who service them — field staff walking
 * a transect, a landowner crossing their own finca — and MegaDetector boxes
 * them like anything else. A reviewer then labels the box "Homo sapiens", which
 * is the correct thing for them to do and is also what turns the crop into an
 * ordinary export candidate: `assignSpecies` promotes a person box to
 * `detection_class = 0` so the identification renders, the row is `corrected`
 * (hence verified), and the image is fetchable from Drive. Every hard filter in
 * `collectExportCandidates` passes it.
 *
 * Until this rule existed, the only thing keeping those crops out of an archive
 * was `minExamples` — a free-text number in the export form. It was 30 for v1
 * and v2, and both of those manifests carry `homo_sapiens` in `classList`.
 *
 * These tests pin the rule at the level that matters: the real query path, with
 * a threshold low enough that arithmetic alone would let humans through.
 */
import { describe, it, expect, beforeEach } from "vitest";
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

setupIntegrationDbMock();
setupAuthMocks();

import { getExportPreview } from "@/app/camera-trap/training-exports/actions";

let db: TestDb;

/**
 * A deployment holding `count` verified detections of `species`.
 *
 * `detectionClass` defaults to 0 because that is what the promotion path
 * produces: a reviewer assigning a species to a person box flips the class.
 * Seeding humans at class 1 would test nothing — the SQL already excludes it.
 */
function seedDeployment(opts: {
  name: string;
  species: string;
  count: number;
  verificationStatus?: "verified" | "corrected";
}): number {
  const [d] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: opts.name,
      status: "verified",
      isExternal: false,
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
        driveFileId: `drive-${opts.name}-${i}`,
        isExternal: false,
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
        verificationStatus: opts.verificationStatus ?? "verified",
      })
      .run();
  }
  return d.id;
}

/** Enough animal material on its own to make a preview that isn't empty. */
function seedAnimals() {
  for (let i = 1; i <= 3; i++) {
    seedDeployment({
      name: `BIO-00${i}`,
      species: "Dasyprocta punctata",
      count: 4,
    });
  }
}

/**
 * Humans across four deployments, so the class clears the ≥3-deployment
 * coverage rule as comfortably as any real species would.
 */
function seedHumans(label = "Homo sapiens", perDeployment = 4) {
  for (let i = 1; i <= 4; i++) {
    seedDeployment({
      name: `PEOPLE-00${i}`,
      species: label,
      count: perDeployment,
      // What the promotion path writes: the reviewer overruled the model.
      verificationStatus: "corrected",
    });
  }
}

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;
  mockRequireAdmin.mockResolvedValue(testAdmin);
});

describe("training export — human exclusion", () => {
  it("keeps Homo sapiens out of the class list at a threshold it would otherwise clear", async () => {
    seedAnimals();
    seedHumans(); // 16 crops over 4 deployments

    // minExamples = 2: every threshold that has ever hidden this class is off.
    const res = await getExportPreview(2);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.classList).not.toContain("Homo sapiens");
    expect(res.data.classList).toContain("Dasyprocta punctata");
  });

  it("does not park them in droppedSpecies either — that list means 'lower the threshold'", async () => {
    seedAnimals();
    seedHumans();

    const res = await getExportPreview(2);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(Object.keys(res.data.droppedSpecies)).not.toContain("Homo sapiens");
    expect(res.data.perSpecies.map((r) => r.label)).not.toContain(
      "Homo sapiens",
    );
  });

  it("reports how many crops it withheld, so the exclusion is auditable", async () => {
    seedAnimals();
    seedHumans();

    const res = await getExportPreview(2);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.excludedHumanCrops).toBe(16);
  });

  it("reports zero rather than nothing when the corpus has no people in it", async () => {
    seedAnimals();

    const res = await getExportPreview(2);
    expect(res.success).toBe(true);
    if (!res.success) return;

    // A reader of an all-animal export can tell the filter ran.
    expect(res.data.excludedHumanCrops).toBe(0);
  });

  it("withholds them whatever vocabulary they arrived under", async () => {
    seedAnimals();
    // One label per bucket: the portal's own, an imported corpus's, the
    // Spanish UI's, and the exporter's folder-name form.
    seedHumans("Homo sapiens sapiens", 3);
    for (const label of ["person", "Humano", "homo_sapiens"]) {
      for (let i = 1; i <= 3; i++) {
        seedDeployment({ name: `${label}-${i}`, species: label, count: 3 });
      }
    }

    const res = await getExportPreview(2);
    expect(res.success).toBe(true);
    if (!res.success) return;

    const surfaced = [
      ...res.data.classList,
      ...Object.keys(res.data.droppedSpecies),
    ];
    for (const label of [
      "Homo sapiens sapiens",
      "person",
      "Humano",
      "homo_sapiens",
    ]) {
      expect(surfaced).not.toContain(label);
    }
    expect(res.data.excludedHumanCrops).toBe(12 + 27);
  });

  it("leaves the human crops out of the candidate total the preview reports", async () => {
    seedAnimals(); // 12 animal crops
    seedHumans(); // 16 human crops

    const res = await getExportPreview(2);
    expect(res.success).toBe(true);
    if (!res.success) return;

    // Not 28. The withheld rows are counted once, in their own field.
    expect(res.data.totalCandidates).toBe(12);
  });

  it("does not touch a genuine taxon whose name merely starts the same way", async () => {
    seedAnimals();
    for (let i = 1; i <= 3; i++) {
      seedDeployment({
        name: `BECARD-${i}`,
        species: "Pachyramphus homochrous",
        count: 3,
      });
    }

    const res = await getExportPreview(2);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.classList).toContain("Pachyramphus homochrous");
    expect(res.data.excludedHumanCrops).toBe(0);
  });
});
