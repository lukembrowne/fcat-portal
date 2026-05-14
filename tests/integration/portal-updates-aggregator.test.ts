/**
 * Integration tests for the portal-updates aggregator.
 *
 * Uses a real in-memory SQLite database (createTestDb) and seeds multi-project
 * camera-trap + audio data covering the four metrics the daily email reports.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, testDbRef, setupIntegrationDbMock } from "../helpers/test-db";

setupIntegrationDbMock();

const aggregator = await import("@/lib/portal-updates/aggregator");

let db: ReturnType<typeof createTestDb>;

const NOW = new Date("2026-05-14T12:00:00Z");
const WINDOW_START = new Date("2026-05-13T12:00:00Z");

function inWindow(offsetHoursAfterStart: number): Date {
  return new Date(WINDOW_START.getTime() + offsetHoursAfterStart * 3600_000);
}

function outsideWindow(): Date {
  return new Date(WINDOW_START.getTime() - 24 * 3600_000);
}

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;

  // Add a second project for multi-project assertions.
  // (createTestDb already seeded "camera-trap".)
  db.insert(schema.projects)
    .values({ id: "biochoco", name: "BioChoco" })
    .run();
});

// ---------------------------------------------------------------------------
// Helpers — seed minimal rows for each metric path
// ---------------------------------------------------------------------------

function makeDeployment(projectId: string, name = `D-${projectId}`): number {
  const [d] = db
    .insert(schema.deployments)
    .values({
      projectId,
      name,
      status: "processed",
    })
    .returning()
    .all();
  return d.id;
}

function makeImage(deploymentId: number): number {
  const [img] = db
    .insert(schema.images)
    .values({
      deploymentId,
      filename: `IMG-${Math.random()}.jpg`,
      status: "processed",
    })
    .returning()
    .all();
  return img.id;
}

function makeIdentification(args: {
  imageId: number;
  status: "verified" | "corrected" | "rejected" | "unverified";
  verifiedBy: string | null;
  verifiedAt: Date | null;
  species?: string;
}): number {
  const [det] = db
    .insert(schema.detections)
    .values({
      imageId: args.imageId,
      bboxX: 0.1,
      bboxY: 0.1,
      bboxWidth: 0.5,
      bboxHeight: 0.5,
      detectionConfidence: 0.9,
    })
    .returning()
    .all();

  const [ident] = db
    .insert(schema.identifications)
    .values({
      detectionId: det.id,
      species: args.species ?? "Sp",
      confidence: 0.9,
      verificationStatus: args.status,
      verifiedBy: args.verifiedBy,
      verifiedAt: args.verifiedAt,
    })
    .returning()
    .all();
  return ident.id;
}

function makeAudioFile(deploymentId: number): number {
  const [af] = db
    .insert(schema.audioFiles)
    .values({
      deploymentId,
      filename: `AUDIO-${Math.random()}.flac`,
    })
    .returning()
    .all();
  return af.id;
}

function makeAudioIdentification(args: {
  audioFileId: number;
  status: "verified" | "corrected" | "rejected" | "unverified";
  verifiedBy: string | null;
  verifiedAt: Date | null;
  species?: string;
}): number {
  const [det] = db
    .insert(schema.audioDetections)
    .values({
      audioFileId: args.audioFileId,
      startTime: 0,
      endTime: 1,
      minFreq: 0,
      maxFreq: 8000,
      confidence: 0.9,
    })
    .returning()
    .all();

  const [ident] = db
    .insert(schema.audioIdentifications)
    .values({
      audioDetectionId: det.id,
      species: args.species ?? "Sp",
      confidence: 0.9,
      verificationStatus: args.status,
      verifiedBy: args.verifiedBy,
      verifiedAt: args.verifiedAt,
    })
    .returning()
    .all();
  return ident.id;
}

function makeJob(args: {
  deploymentId: number | null;
  jobType: string;
  status: "completed" | "failed" | "pending" | "processing" | "cancelled";
  completedAt: Date | null;
}): void {
  db.insert(schema.processingJobs)
    .values({
      deploymentId: args.deploymentId,
      jobType: args.jobType,
      status: args.status,
      completedAt: args.completedAt,
    })
    .run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildPortalUpdatesPayload — empty state", () => {
  it("returns empty projects + zero totals when nothing is in the window", async () => {
    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);
    expect(payload.projects).toEqual([]);
    expect(payload.totalCtJobs).toBe(0);
    expect(payload.totalAudioJobs).toBe(0);
    expect(payload.totalCtVerifiedImages).toBe(0);
    expect(payload.totalAudioVerifiedFiles).toBe(0);
    expect(payload.windowStart).toBe(WINDOW_START);
    expect(payload.windowEnd).toBe(NOW);
  });
});

describe("buildPortalUpdatesPayload — camera-trap jobs", () => {
  it("counts completed + failed jobs by type per project; ignores pending/cancelled", async () => {
    const ct = makeDeployment("camera-trap");
    const bc = makeDeployment("biochoco");

    makeJob({ deploymentId: ct, jobType: "ml", status: "completed", completedAt: inWindow(2) });
    makeJob({ deploymentId: ct, jobType: "ml", status: "completed", completedAt: inWindow(3) });
    makeJob({ deploymentId: ct, jobType: "ml", status: "failed", completedAt: inWindow(4) });
    makeJob({ deploymentId: ct, jobType: "drive_sync", status: "completed", completedAt: inWindow(5) });

    makeJob({ deploymentId: bc, jobType: "ml", status: "completed", completedAt: inWindow(6) });

    // Should be excluded
    makeJob({ deploymentId: ct, jobType: "ml", status: "pending", completedAt: null });
    makeJob({ deploymentId: ct, jobType: "ml", status: "cancelled", completedAt: inWindow(7) });
    makeJob({ deploymentId: ct, jobType: "ml", status: "completed", completedAt: outsideWindow() });

    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);

    const ctp = payload.projects.find((p) => p.projectId === "camera-trap")!;
    expect(ctp).toBeDefined();
    const mlBucket = ctp.ctJobs.find((b) => b.jobType === "ml")!;
    expect(mlBucket.completed).toBe(2);
    expect(mlBucket.failed).toBe(1);

    const driveBucket = ctp.ctJobs.find((b) => b.jobType === "drive_sync")!;
    expect(driveBucket.completed).toBe(1);
    expect(driveBucket.failed).toBe(0);

    const bcp = payload.projects.find((p) => p.projectId === "biochoco")!;
    expect(bcp.ctJobs.find((b) => b.jobType === "ml")!.completed).toBe(1);

    expect(payload.totalCtJobs).toBe(5);
    expect(payload.totalAudioJobs).toBe(0);
  });

  it("skips jobs with NULL deployment_id (no project to attribute)", async () => {
    makeJob({ deploymentId: null, jobType: "ml", status: "completed", completedAt: inWindow(2) });

    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);

    expect(payload.totalCtJobs).toBe(0);
    expect(payload.projects).toEqual([]);
  });
});

describe("buildPortalUpdatesPayload — audio jobs", () => {
  it("buckets audio job types separately from CT jobs", async () => {
    const ct = makeDeployment("camera-trap");

    makeJob({ deploymentId: ct, jobType: "birdnet", status: "completed", completedAt: inWindow(2) });
    makeJob({ deploymentId: ct, jobType: "acoustic_indices", status: "completed", completedAt: inWindow(3) });
    makeJob({ deploymentId: ct, jobType: "audio_compression", status: "failed", completedAt: inWindow(4) });
    makeJob({ deploymentId: ct, jobType: "ml", status: "completed", completedAt: inWindow(5) });

    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);
    const ctp = payload.projects.find((p) => p.projectId === "camera-trap")!;

    expect(ctp.audioJobs).toHaveLength(3);
    expect(ctp.audioJobs.find((b) => b.jobType === "birdnet")!.completed).toBe(1);
    expect(ctp.audioJobs.find((b) => b.jobType === "audio_compression")!.failed).toBe(1);

    expect(ctp.ctJobs).toHaveLength(1);
    expect(ctp.ctJobs[0].jobType).toBe("ml");

    expect(payload.totalCtJobs).toBe(1);
    expect(payload.totalAudioJobs).toBe(3);
  });
});

describe("buildPortalUpdatesPayload — camera-trap verifications", () => {
  it("counts distinct images verified per project, not raw identifications", async () => {
    const ct = makeDeployment("camera-trap");

    const img1 = makeImage(ct);
    // Two identifications on same image — should count as 1 distinct image
    makeIdentification({
      imageId: img1, status: "verified", verifiedBy: "alice@x.com", verifiedAt: inWindow(1),
    });
    makeIdentification({
      imageId: img1, status: "verified", verifiedBy: "alice@x.com", verifiedAt: inWindow(2),
    });

    const img2 = makeImage(ct);
    makeIdentification({
      imageId: img2, status: "verified", verifiedBy: "alice@x.com", verifiedAt: inWindow(3),
    });

    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);
    const ctp = payload.projects.find((p) => p.projectId === "camera-trap")!;

    expect(ctp.ctVerifiedImages).toBe(2);
    expect(payload.totalCtVerifiedImages).toBe(2);
  });

  it("project total does NOT double-count when one image is verified by two users", async () => {
    const ct = makeDeployment("camera-trap");

    const img = makeImage(ct);
    makeIdentification({
      imageId: img, status: "verified", verifiedBy: "alice@x.com", verifiedAt: inWindow(1),
    });
    makeIdentification({
      imageId: img, status: "verified", verifiedBy: "bob@x.com", verifiedAt: inWindow(2),
    });

    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);
    const ctp = payload.projects.find((p) => p.projectId === "camera-trap")!;

    // Project total: 1 distinct image
    expect(ctp.ctVerifiedImages).toBe(1);
    // Leaderboard: each user gets credit for the image they touched
    const leaderboard = ctp.ctTopVerificadores;
    expect(leaderboard.find((r) => r.actorEmail === "alice@x.com")?.count).toBe(1);
    expect(leaderboard.find((r) => r.actorEmail === "bob@x.com")?.count).toBe(1);
  });

  it("counts BOTH 'verified' and 'corrected' as verification work; excludes 'rejected' and 'unverified'", async () => {
    const ct = makeDeployment("camera-trap");

    const a = makeImage(ct);
    const b = makeImage(ct);
    const c = makeImage(ct);
    const d = makeImage(ct);

    makeIdentification({
      imageId: a, status: "verified", verifiedBy: "alice@x.com", verifiedAt: inWindow(1),
    });
    makeIdentification({
      imageId: b, status: "corrected", verifiedBy: "alice@x.com", verifiedAt: inWindow(2),
    });
    makeIdentification({
      imageId: c, status: "rejected", verifiedBy: "alice@x.com", verifiedAt: inWindow(3),
    });
    makeIdentification({
      imageId: d, status: "unverified", verifiedBy: null, verifiedAt: null,
    });

    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);
    const ctp = payload.projects.find((p) => p.projectId === "camera-trap")!;

    expect(ctp.ctVerifiedImages).toBe(2);
  });

  it("leaderboard sorts by count desc, ties broken by email asc, capped at top 3", async () => {
    const ct = makeDeployment("camera-trap");

    // Alice: 5 images, Bob: 3, Carol: 3, Dave: 1, Erin: 1
    for (const email of [
      ["alice@x.com", 5],
      ["bob@x.com", 3],
      ["carol@x.com", 3],
      ["dave@x.com", 1],
      ["erin@x.com", 1],
    ] as Array<[string, number]>) {
      const [user, n] = email;
      for (let i = 0; i < n; i++) {
        const img = makeImage(ct);
        makeIdentification({
          imageId: img,
          status: "verified",
          verifiedBy: user,
          verifiedAt: inWindow(1 + i * 0.1),
        });
      }
    }

    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);
    const ctp = payload.projects.find((p) => p.projectId === "camera-trap")!;
    const lb = ctp.ctTopVerificadores;

    expect(lb).toHaveLength(3);
    expect(lb[0]).toEqual({ actorEmail: "alice@x.com", count: 5 });
    // Bob & Carol tied at 3 — alphabetical tiebreak puts bob first
    expect(lb[1]).toEqual({ actorEmail: "bob@x.com", count: 3 });
    expect(lb[2]).toEqual({ actorEmail: "carol@x.com", count: 3 });
  });

  it("excludes verifications outside the window", async () => {
    const ct = makeDeployment("camera-trap");
    const img = makeImage(ct);
    makeIdentification({
      imageId: img,
      status: "verified",
      verifiedBy: "alice@x.com",
      verifiedAt: outsideWindow(),
    });

    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);
    expect(payload.totalCtVerifiedImages).toBe(0);
    expect(payload.projects).toEqual([]);
  });
});

describe("buildPortalUpdatesPayload — audio verifications", () => {
  it("counts distinct audio files verified, with leaderboard", async () => {
    const ct = makeDeployment("camera-trap");
    const af1 = makeAudioFile(ct);
    const af2 = makeAudioFile(ct);

    // af1 has two identifications by alice (1 distinct file for her)
    makeAudioIdentification({
      audioFileId: af1, status: "verified", verifiedBy: "alice@x.com", verifiedAt: inWindow(1),
    });
    makeAudioIdentification({
      audioFileId: af1, status: "corrected", verifiedBy: "alice@x.com", verifiedAt: inWindow(2),
    });
    // af2 verified by bob
    makeAudioIdentification({
      audioFileId: af2, status: "verified", verifiedBy: "bob@x.com", verifiedAt: inWindow(3),
    });

    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);
    const ctp = payload.projects.find((p) => p.projectId === "camera-trap")!;

    expect(ctp.audioVerifiedFiles).toBe(2);
    expect(ctp.audioTopVerificadores).toEqual([
      { actorEmail: "alice@x.com", count: 1 },
      { actorEmail: "bob@x.com", count: 1 },
    ]);
    expect(payload.totalAudioVerifiedFiles).toBe(2);
  });
});

describe("buildPortalUpdatesPayload — project filtering & sorting", () => {
  it("only includes projects with non-zero activity, sorted by name", async () => {
    // Add a third project with no activity
    db.insert(schema.projects).values({ id: "finance", name: "Finanzas" }).run();

    const ct = makeDeployment("camera-trap");
    const bc = makeDeployment("biochoco");

    // BioChoco only has audio verification
    const af = makeAudioFile(bc);
    makeAudioIdentification({
      audioFileId: af, status: "verified", verifiedBy: "alice@x.com", verifiedAt: inWindow(1),
    });

    // camera-trap only has a job
    makeJob({ deploymentId: ct, jobType: "ml", status: "completed", completedAt: inWindow(2) });

    const payload = await aggregator.buildPortalUpdatesPayload(WINDOW_START, NOW);

    expect(payload.projects.map((p) => p.projectId)).toEqual([
      "biochoco",
      "camera-trap",
    ]);
    expect(payload.projects.find((p) => p.projectId === "finance")).toBeUndefined();
  });
});
