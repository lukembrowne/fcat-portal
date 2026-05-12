/**
 * Integration tests for getAcousticIndicesForProject.
 *
 * Covers the per-deployment median + (habitat, diel_period) grouping logic
 * plus the two soft-failure paths the plan calls out:
 *
 *   - Empty state: no rows → empty groups + totalDeployments = 0.
 *   - Low-coverage cohort: nFiles correctly reflects per-deployment counts.
 *   - ODK unreachable: habitatKey falls through to "unknown".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

// ODK habitat map fetcher — overridable per test.
const mockFetchEntities = vi.fn();
vi.mock("@/lib/odk-client", () => ({
  fetchEntities: (...args: unknown[]) => mockFetchEntities(...args),
}));

const { getAcousticIndicesForProject } = await import("@/app/audio/actions");

let db: TestDb;
let ctProjectId: number;

interface SeedDeploymentInput {
  name: string;
  siteName?: string | null;
  files: Array<{
    filename: string;
    dielPeriod: string;
    soundscapeSaturation: number;
    acousticComplexityIndex?: number;
  }>;
}

/** Helper: seed a deployment with N audio files, each with one acoustic_indices row. */
function seedDeployment(input: SeedDeploymentInput) {
  const [deployment] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: input.name,
      status: "scanned",
      cameraTrapProjectId: ctProjectId,
      siteName: input.siteName ?? null,
      uploadAudioFolderId: "drive_xyz",
    })
    .returning()
    .all();

  for (const file of input.files) {
    const [audioFile] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId: deployment.id,
        filename: file.filename,
        driveFileId: `drive_${deployment.id}_${file.filename}`,
      })
      .returning()
      .all();

    db.insert(schema.acousticIndices)
      .values({
        audioFileId: audioFile.id,
        soundscapeSaturation: file.soundscapeSaturation,
        acousticComplexityIndex: file.acousticComplexityIndex ?? 1500,
        frequencyEntropy: 0.7,
        temporalEntropy: 0.6,
        eventsPerSecond: 0.05,
        recordedDate: "2026-01-19",
        dielPeriod: file.dielPeriod,
        configHash: "sha256:test",
        computedAt: new Date(),
      })
      .run();
  }

  return deployment;
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
  mockRequirePermission.mockResolvedValue(testUser);

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "AcousticTestProject" })
    .returning()
    .all();
  ctProjectId = ctProject.id;
});

describe("getAcousticIndicesForProject", () => {
  it("returns empty groups when no acoustic_indices rows exist", async () => {
    mockFetchEntities.mockResolvedValue([]);

    const result = await getAcousticIndicesForProject(ctProjectId);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.groups).toEqual([]);
    expect(result.data.totalDeployments).toBe(0);
  });

  it("computes per-deployment medians and groups by (habitat, diel_period)", async () => {
    mockFetchEntities.mockResolvedValue([
      { site_id: "SEC-006", site_name: "SEC-006", habitat_type: "primary_forest" },
      { site_id: "SEC-007", site_name: "SEC-007", habitat_type: "primary_forest" },
    ]);

    seedDeployment({
      name: "SEC-006_V1",
      siteName: "SEC-006",
      files: [
        { filename: "a_20260119_063500.wav", dielPeriod: "dawn", soundscapeSaturation: 0.20 },
        { filename: "b_20260119_063600.wav", dielPeriod: "dawn", soundscapeSaturation: 0.40 },
        { filename: "c_20260119_063700.wav", dielPeriod: "dawn", soundscapeSaturation: 0.60 },
      ],
    });
    seedDeployment({
      name: "SEC-007_V1",
      siteName: "SEC-007",
      files: [
        { filename: "a_20260119_063500.wav", dielPeriod: "dawn", soundscapeSaturation: 0.80 },
        { filename: "b_20260119_063600.wav", dielPeriod: "dawn", soundscapeSaturation: 0.90 },
      ],
    });

    const result = await getAcousticIndicesForProject(ctProjectId);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.totalDeployments).toBe(2);
    expect(result.data.groups).toHaveLength(1);

    const group = result.data.groups[0];
    expect(group.habitatKey).toBe("primary_forest");
    expect(group.dielPeriod).toBe("dawn");
    expect(group.points).toHaveLength(2);

    const sec006 = group.points.find((p) => p.deploymentName === "SEC-006_V1");
    expect(sec006?.nFiles).toBe(3);
    // Median of [0.2, 0.4, 0.6] = 0.4
    expect(sec006?.soundscapeSaturation).toBeCloseTo(0.40, 5);

    const sec007 = group.points.find((p) => p.deploymentName === "SEC-007_V1");
    expect(sec007?.nFiles).toBe(2);
    // Median of [0.8, 0.9] = 0.85 (midpoint)
    expect(sec007?.soundscapeSaturation).toBeCloseTo(0.85, 5);
  });

  it("falls through to 'unknown' habitat when ODK is unreachable", async () => {
    mockFetchEntities.mockRejectedValue(new Error("ODK API down"));

    seedDeployment({
      name: "ABC-001_V1",
      siteName: "ABC-001",
      files: [
        { filename: "a_20260119_063500.wav", dielPeriod: "dawn", soundscapeSaturation: 0.5 },
      ],
    });

    const result = await getAcousticIndicesForProject(ctProjectId);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.groups).toHaveLength(1);
    expect(result.data.groups[0].habitatKey).toBe("unknown");
    expect(result.data.groups[0].habitatLabel).toBe("Sin clasificar");
    // Visual contract — the box plot uses this to flag low-coverage cells.
    expect(result.data.groups[0].points[0].nFiles).toBe(1);
  });

  it("buckets rows with unknown diel_period values into 'other'", async () => {
    mockFetchEntities.mockResolvedValue([
      { site_id: "SEC-006", site_name: "SEC-006", habitat_type: "secondary_forest" },
    ]);

    seedDeployment({
      name: "SEC-006_V1",
      siteName: "SEC-006",
      files: [
        { filename: "x.wav", dielPeriod: "weird", soundscapeSaturation: 0.3 },
      ],
    });

    const result = await getAcousticIndicesForProject(ctProjectId);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.groups[0].dielPeriod).toBe("other");
  });
});
