import { describe, it, expect, beforeEach } from "vitest";
import {
  setupIntegrationDbMock,
  testDbRef,
  createTestDb,
  type TestDb,
} from "./helpers/test-db";
import * as schema from "@/db/schema";
import type { AuthUser } from "@/lib/types";

setupIntegrationDbMock();

const {
  getUserCameraTrapProjects,
  ctProjectFilter,
  requireDeploymentAccess,
  getDeploymentIdForImage,
  getDeploymentIdForDetection,
  getDeploymentIdForIdentification,
} = await import("@/lib/camera-trap-auth");

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    email: "test@fcat.org",
    name: "Test User",
    isExternal: false,
    globalRole: null,
    permissions: [{ projectId: "camera-trap", role: "editor" }],
    ...overrides,
  };
}

let testDb: TestDb;

function seedCtProjects(db: TestDb) {
  // Create a user
  db.insert(schema.users)
    .values({ email: "test@fcat.org", name: "Test User" })
    .run();
  db.insert(schema.users)
    .values({ email: "other@fcat.org", name: "Other User" })
    .run();

  // Create CT projects
  const [proj1] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "General" })
    .returning()
    .all();
  const [proj2] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "BioChoco", driveFolderId: "drive-folder-123" })
    .returning()
    .all();
  const [proj3] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "Canande" })
    .returning()
    .all();

  // Give test user access to General and BioChoco
  db.insert(schema.cameraTrapProjectAccess)
    .values([
      { userEmail: "test@fcat.org", cameraTrapProjectId: proj1.id },
      { userEmail: "test@fcat.org", cameraTrapProjectId: proj2.id },
    ])
    .run();

  // Give other user access to Canande only
  db.insert(schema.cameraTrapProjectAccess)
    .values([
      { userEmail: "other@fcat.org", cameraTrapProjectId: proj3.id },
    ])
    .run();

  // Create deployments in different projects
  const [dep1] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "DEP-GENERAL-001",
      cameraTrapProjectId: proj1.id,
    })
    .returning()
    .all();
  const [dep2] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "DEP-BIOCHOCO-001",
      cameraTrapProjectId: proj2.id,
    })
    .returning()
    .all();
  const [dep3] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "DEP-CANANDE-001",
      cameraTrapProjectId: proj3.id,
    })
    .returning()
    .all();

  return { proj1, proj2, proj3, dep1, dep2, dep3 };
}

describe("getUserCameraTrapProjects", () => {
  beforeEach(() => {
    testDb = createTestDb();
    testDbRef.current = testDb;
  });

  it("returns 'all' for super admin", async () => {
    const user = makeUser({ globalRole: "super_admin" });
    const result = await getUserCameraTrapProjects(user);
    expect(result).toBe("all");
  });

  it("returns assigned project IDs for regular user", async () => {
    const { proj1, proj2 } = seedCtProjects(testDb);
    const user = makeUser({ email: "test@fcat.org" });
    const result = await getUserCameraTrapProjects(user);
    expect(result).toEqual([proj1.id, proj2.id]);
  });

  it("returns empty array for user with no CT project access", async () => {
    seedCtProjects(testDb);
    const user = makeUser({ email: "nobody@fcat.org" });
    const result = await getUserCameraTrapProjects(user);
    expect(result).toEqual([]);
  });
});

describe("ctProjectFilter", () => {
  it("returns undefined for 'all'", () => {
    expect(ctProjectFilter("all")).toBeUndefined();
  });

  it("returns a SQL clause for a list of project IDs", () => {
    const filter = ctProjectFilter([1, 2]);
    expect(filter).toBeDefined();
  });

  it("returns a no-match clause for empty array", () => {
    const filter = ctProjectFilter([]);
    expect(filter).toBeDefined();
  });
});

describe("requireDeploymentAccess", () => {
  beforeEach(() => {
    testDb = createTestDb();
    testDbRef.current = testDb;
  });

  it("allows super admin access to any deployment", async () => {
    const { dep3 } = seedCtProjects(testDb);
    const user = makeUser({ globalRole: "super_admin" });
    await expect(
      requireDeploymentAccess(user, dep3.id)
    ).resolves.toBeUndefined();
  });

  it("allows access when user has project access", async () => {
    const { dep1 } = seedCtProjects(testDb);
    const user = makeUser({ email: "test@fcat.org" });
    await expect(
      requireDeploymentAccess(user, dep1.id)
    ).resolves.toBeUndefined();
  });

  it("throws when user lacks project access", async () => {
    const { dep3 } = seedCtProjects(testDb);
    const user = makeUser({ email: "test@fcat.org" });
    await expect(
      requireDeploymentAccess(user, dep3.id)
    ).rejects.toThrow("No tienes acceso a este proyecto");
  });

  it("throws when deployment does not exist", async () => {
    seedCtProjects(testDb);
    const user = makeUser({ email: "test@fcat.org" });
    await expect(
      requireDeploymentAccess(user, 99999)
    ).rejects.toThrow("Instalación no encontrada");
  });
});

describe("entity resolution helpers", () => {
  beforeEach(() => {
    testDb = createTestDb();
    testDbRef.current = testDb;
  });

  it("resolves image → deploymentId", async () => {
    const { dep1 } = seedCtProjects(testDb);
    const [img] = testDb
      .insert(schema.images)
      .values({
        deploymentId: dep1.id,
        filename: "IMG_001.jpg",
      })
      .returning()
      .all();
    const result = await getDeploymentIdForImage(img.id);
    expect(result).toBe(dep1.id);
  });

  it("resolves detection → deploymentId", async () => {
    const { dep1 } = seedCtProjects(testDb);
    const [img] = testDb
      .insert(schema.images)
      .values({ deploymentId: dep1.id, filename: "IMG_001.jpg" })
      .returning()
      .all();
    const [det] = testDb
      .insert(schema.detections)
      .values({
        imageId: img.id,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.5,
        bboxHeight: 0.5,
        detectionConfidence: 0.9,
        detectionClass: 0,
      })
      .returning()
      .all();
    const result = await getDeploymentIdForDetection(det.id);
    expect(result).toBe(dep1.id);
  });

  it("resolves identification → deploymentId", async () => {
    const { dep1 } = seedCtProjects(testDb);
    const [img] = testDb
      .insert(schema.images)
      .values({ deploymentId: dep1.id, filename: "IMG_001.jpg" })
      .returning()
      .all();
    const [det] = testDb
      .insert(schema.detections)
      .values({
        imageId: img.id,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.5,
        bboxHeight: 0.5,
        detectionConfidence: 0.9,
        detectionClass: 0,
      })
      .returning()
      .all();
    const [ident] = testDb
      .insert(schema.identifications)
      .values({
        detectionId: det.id,
        species: "Dasyprocta punctata",
        confidence: 0.88,
      })
      .returning()
      .all();
    const result = await getDeploymentIdForIdentification(ident.id);
    expect(result).toBe(dep1.id);
  });

  it("returns null for non-existent image", async () => {
    const result = await getDeploymentIdForImage(99999);
    expect(result).toBeNull();
  });
});
