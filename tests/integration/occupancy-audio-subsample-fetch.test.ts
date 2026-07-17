/**
 * U2: fetchOccupancyInputs' audio stream counts a detection only when its
 * source recording is in the canonical kept set (first file per 10-min
 * wall-clock bucket). A detection sitting solely on a dropped (non-earliest)
 * file is removed from the occupancy matrix; the camera stream and the survey
 * window are untouched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, testDbRef, setupIntegrationDbMock, type TestDb } from "../helpers/test-db";

setupIntegrationDbMock();

import { fetchOccupancyInputs } from "@/lib/occupancy/fetch";

let db: TestDb;
let biochocoId: number;

function seedDeployment(name: string): number {
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
      dateEnd: "2026-03-05",
      excludedAudio: false,
      excludedCamera: false,
    })
    .returning()
    .all();
  return d.id;
}

/** Insert an audio file with a canonical `<serial>_YYYYMMDD_HHMMSS.wav` name. */
function addFile(depId: number, ymd: string, hms: string): number {
  const [f] = db
    .insert(schema.audioFiles)
    .values({ deploymentId: depId, filename: `2MM00000_${ymd}_${hms}.wav` })
    .returning()
    .all();
  return f.id;
}

/** Attach a high-confidence species identification to an audio file. */
function addDetection(fileId: number, species: string): void {
  const [det] = db
    .insert(schema.audioDetections)
    .values({ audioFileId: fileId, startTime: 0, endTime: 3, minFreq: 500, maxFreq: 8000, confidence: 0.99 })
    .returning()
    .all();
  db.insert(schema.audioIdentifications)
    .values({ audioDetectionId: det.id, species, confidence: 0.99 })
    .run();
}

const speciesAt = (siteId: string, species: string) =>
  fetchOccupancyInputs("audio").detections.filter(
    (d) => d.siteId === siteId && d.species === species,
  );

describe("fetchOccupancyInputs — audio recording-schedule subsampling", () => {
  beforeEach(() => {
    db = createTestDb();
    testDbRef.current = db;
    const [biochoco] = db
      .insert(schema.cameraTrapProjects)
      .values({ name: "BioChoco" })
      .returning()
      .all();
    biochocoId = biochoco.id;
  });

  it("drops a detection that sits only on a non-kept (dropped) file", () => {
    const id = seedDeployment("DROP-ONLY");
    addFile(id, "20260301", "100000"); // kept (earliest in the 10:00 bucket)
    const dropped = addFile(id, "20260301", "100500"); // dropped (same bucket)
    addDetection(dropped, "Tinamus major");
    expect(speciesAt(String(id), "Tinamus major")).toHaveLength(0);
  });

  it("keeps a detection on the kept file", () => {
    const id = seedDeployment("KEEP");
    const kept = addFile(id, "20260301", "100000");
    addFile(id, "20260301", "100500"); // dropped
    addDetection(kept, "Tinamus major");
    expect(speciesAt(String(id), "Tinamus major")).toHaveLength(1);
  });

  it("leaves a 10-min deployment's detections intact", () => {
    const id = seedDeployment("TEN-MIN");
    const a = addFile(id, "20260301", "100000");
    const b = addFile(id, "20260301", "101000");
    const c = addFile(id, "20260301", "102000");
    addDetection(a, "Crax rubra");
    addDetection(b, "Crax rubra");
    addDetection(c, "Crax rubra");
    expect(speciesAt(String(id), "Crax rubra")).toHaveLength(3);
  });

  it("populates audioSubsample for the audio stream and leaves it undefined for camera", () => {
    const id = seedDeployment("SUMMARY");
    addFile(id, "20260301", "100000");
    addFile(id, "20260301", "100500"); // one dropped
    const audio = fetchOccupancyInputs("audio");
    const camera = fetchOccupancyInputs("camera");
    expect(audio.audioSubsample).toBeDefined();
    expect(audio.audioSubsample!.filesTotal).toBe(2);
    expect(audio.audioSubsample!.filesDropped).toBe(1);
    expect(camera.audioSubsample).toBeUndefined();
  });

  it("does not move the survey window (KTD3: windows derive from the full file set)", () => {
    const id = seedDeployment("WINDOW");
    // Files span 03-01 .. 03-04; several would be dropped by subsampling, but
    // the window must still reflect the full span.
    addFile(id, "20260301", "100000");
    addFile(id, "20260301", "100500"); // dropped
    addFile(id, "20260304", "100000");
    addFile(id, "20260304", "100500"); // dropped
    const site = fetchOccupancyInputs("audio").sites.find((s) => s.siteId === String(id))!;
    expect(site.windowStart.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(site.windowEnd.toISOString().slice(0, 10)).toBe("2026-03-04");
  });
});
