/**
 * Per-stream occupancy exclusion: fetchOccupancyInputs' camera stream drops
 * excluded_camera=1 deployments and the audio stream drops excluded_audio=1, so
 * a deployment whose audio recorder failed but whose camera is fine (CCN-010)
 * stays in the camera analysis while leaving the audio one — and vice versa.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, testDbRef, setupIntegrationDbMock, type TestDb } from "../helpers/test-db";

setupIntegrationDbMock();

import { fetchOccupancyInputs } from "@/lib/occupancy/fetch";

let db: TestDb;
let biochocoId: number;

async function seedDeployment(
  name: string,
  flags: { excludedAudio: boolean; excludedCamera: boolean },
): Promise<number> {
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
      dateEnd: "2026-03-25",
      excludedAudio: flags.excludedAudio,
      excludedCamera: flags.excludedCamera,
    })
    .returning()
    .all();
  return d.id;
}

describe("fetchOccupancyInputs — per-stream exclusion", () => {
  beforeEach(async () => {
    db = createTestDb();
    testDbRef.current = db;
    const [biochoco] = db
      .insert(schema.cameraTrapProjects)
      .values({ name: "BioChoco" })
      .returning()
      .all();
    biochocoId = biochoco.id;
  });

  it("keeps a deployment in both streams when neither flag is set", async () => {
    const id = await seedDeployment("BOTH-IN", { excludedAudio: false, excludedCamera: false });
    const camera = fetchOccupancyInputs("camera").sites.map((s) => s.siteId);
    const audio = fetchOccupancyInputs("audio").sites.map((s) => s.siteId);
    expect(camera).toContain(String(id));
    expect(audio).toContain(String(id));
  });

  it("drops from audio only when excluded_audio is set (the CCN-010 case)", async () => {
    const id = await seedDeployment("AUDIO-OUT", { excludedAudio: true, excludedCamera: false });
    const camera = fetchOccupancyInputs("camera").sites.map((s) => s.siteId);
    const audio = fetchOccupancyInputs("audio").sites.map((s) => s.siteId);
    expect(camera).toContain(String(id)); // camera stays
    expect(audio).not.toContain(String(id)); // audio dropped
  });

  it("drops from camera only when excluded_camera is set", async () => {
    const id = await seedDeployment("CAMERA-OUT", { excludedAudio: false, excludedCamera: true });
    const camera = fetchOccupancyInputs("camera").sites.map((s) => s.siteId);
    const audio = fetchOccupancyInputs("audio").sites.map((s) => s.siteId);
    expect(camera).not.toContain(String(id));
    expect(audio).toContain(String(id));
  });

  it("drops from both streams when both flags are set (migrated-legacy behavior)", async () => {
    const id = await seedDeployment("BOTH-OUT", { excludedAudio: true, excludedCamera: true });
    const camera = fetchOccupancyInputs("camera").sites.map((s) => s.siteId);
    const audio = fetchOccupancyInputs("audio").sites.map((s) => s.siteId);
    expect(camera).not.toContain(String(id));
    expect(audio).not.toContain(String(id));
  });
});
