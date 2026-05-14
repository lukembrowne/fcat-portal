/**
 * Integration test for the BirdNET CSV export endpoint.
 *
 * Verifies that the exported CSV (a) respects the threshold from the query
 * string, (b) embeds the threshold in the header comment and filename, and
 * (c) excludes rejected rows regardless of confidence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import {
  createTestDb,
  setupIntegrationDbMock,
  testDbRef,
  type TestDb,
} from "../helpers/test-db";
import {
  mockRequirePermission,
  setupAuthMocks,
  testUser,
} from "../helpers/mock-auth";

setupIntegrationDbMock();
setupAuthMocks();

const { GET } = await import("@/app/api/audio/export/route");

let db: TestDb;
let deploymentId: number;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
  mockRequirePermission.mockResolvedValue(testUser);

  db.insert(schema.users)
    .values({ email: testUser.email, name: testUser.name })
    .onConflictDoNothing()
    .run();

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "ExportTestProject" })
    .returning()
    .all();

  db.insert(schema.cameraTrapProjectAccess)
    .values({ userEmail: testUser.email, cameraTrapProjectId: ctProject.id })
    .onConflictDoNothing()
    .run();

  const [dep] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "EXP-001",
      status: "scanned",
      cameraTrapProjectId: ctProject.id,
      siteName: "EXP-001",
      uploadAudioFolderId: "drive_x",
    })
    .returning()
    .all();
  deploymentId = dep.id;

  const [file] = db
    .insert(schema.audioFiles)
    .values({
      deploymentId,
      filename: "EXP-001_120000.wav",
      driveFileId: "exp-f1",
    })
    .returning()
    .all();

  const detections = db
    .insert(schema.audioDetections)
    .values([
      { audioFileId: file.id, startTime: 0, endTime: 3, minFreq: 100, maxFreq: 8000 },
      { audioFileId: file.id, startTime: 3, endTime: 6, minFreq: 100, maxFreq: 8000 },
      { audioFileId: file.id, startTime: 6, endTime: 9, minFreq: 100, maxFreq: 8000 },
    ])
    .returning()
    .all();

  db.insert(schema.audioIdentifications)
    .values([
      { audioDetectionId: detections[0].id, species: "Toucan", confidence: 0.9, verificationStatus: "unverified" },
      { audioDetectionId: detections[1].id, species: "Guan", confidence: 0.4, verificationStatus: "unverified" },
      { audioDetectionId: detections[2].id, species: "Rejected", confidence: 0.99, verificationStatus: "rejected" },
    ])
    .run();
});

function makeRequest(qs: string) {
  return new Request(`http://localhost/api/audio/export?${qs}`);
}

describe("GET /api/audio/export", () => {
  it("returns CSV at the requested threshold and skips rejected rows", async () => {
    const res = await GET(makeRequest(`deployment=${deploymentId}&conf=0.8`) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("birdnet_dep");
    expect(res.headers.get("Content-Disposition")).toContain("conf080");

    const body = await res.text();
    expect(body).toContain("# confidence_threshold=0.80");
    expect(body).toContain("Toucan");          // 0.9 >= 0.8 → included
    expect(body).not.toContain("Guan");        // 0.4 < 0.8 → excluded
    expect(body).not.toContain("Rejected");    // always excluded
  });

  it("defaults to 0.7 when conf is omitted", async () => {
    const res = await GET(makeRequest(`deployment=${deploymentId}`) as never);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# confidence_threshold=0.70");
    expect(body).toContain("Toucan");
    expect(body).not.toContain("Guan");
  });

  it("clamps invalid conf to the default", async () => {
    const res = await GET(
      makeRequest(`deployment=${deploymentId}&conf=garbage`) as never
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# confidence_threshold=0.70");
  });

  it("at a permissive threshold, includes the sub-default row but never the rejected one", async () => {
    const res = await GET(
      makeRequest(`deployment=${deploymentId}&conf=0.2`) as never
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Toucan");
    expect(body).toContain("Guan");
    expect(body).not.toContain("Rejected");
  });

  it("returns 400 when deployment is missing", async () => {
    const res = await GET(makeRequest("conf=0.7") as never);
    expect(res.status).toBe(400);
  });

  it("returns 400 when deployment is non-numeric", async () => {
    const res = await GET(makeRequest("deployment=abc") as never);
    expect(res.status).toBe(400);
  });
});
