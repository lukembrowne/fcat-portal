/**
 * Orchestration tests for the publish action. The pieces it composes
 * (buildSnapshot, saveReportSnapshot, recordEvent) are tested elsewhere; here we
 * verify admin-gating, single-save, event instrumentation, and failure handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn(async () => ({ email: "admin@fcat-ecuador.org" }));
const buildSnapshot = vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined);
const saveReportSnapshot = vi.fn(async (_snap?: unknown) => {});
const recordEvent = vi.fn(async (_input?: unknown) => {});
const revalidatePath = vi.fn((_path?: string) => {});

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/system-events", () => ({ recordEvent: (i: unknown) => recordEvent(i) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/public-report-snapshot", () => ({
  saveReportSnapshot: (s: unknown) => saveReportSnapshot(s),
  BIOCHOCO_OVERVIEW_SLUG: "biochoco-overview",
}));
vi.mock("@/app/public/biochoco-overview/lib/build-snapshot", () => ({
  buildSnapshot: (...a: unknown[]) => buildSnapshot(...a),
}));
vi.mock("@/app/public/biochoco-overview/curation", () => ({
  CURATED_IMAGES: [],
  CURATED_AUDIO: [],
}));

const { publishBiochocoOverview } = await import(
  "@/app/public/biochoco-overview/publish-actions"
);

const fakeSnapshot = {
  slug: "biochoco-overview",
  generatedAt: "2026-07-14T00:00:00.000Z",
  generatedBy: "admin@fcat-ecuador.org",
  stats: { retrievedCount: 62, cameraRealSpecies: 32 },
  images: [{ imageId: 1 }, { imageId: 2 }],
  audio: [{ audioId: 9 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ email: "admin@fcat-ecuador.org" });
  buildSnapshot.mockResolvedValue(fakeSnapshot);
});

describe("publishBiochocoOverview", () => {
  it("rejects non-admins before any write", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(publishBiochocoOverview()).rejects.toThrow();
    expect(saveReportSnapshot).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("saves exactly one snapshot, revalidates, and records one event on success", async () => {
    const result = await publishBiochocoOverview();
    expect(result.success).toBe(true);
    expect(saveReportSnapshot).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/public/biochoco-overview");
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent.mock.calls[0][0]).toMatchObject({
      source: "biochoco-overview",
      eventType: "public_report_published",
      severity: "success",
    });
    if (result.success) {
      expect(result.data).toMatchObject({ imageCount: 2, audioCount: 1 });
    }
  });

  it("returns an error and records no event when the build fails (no partial publish)", async () => {
    buildSnapshot.mockRejectedValueOnce(new Error("db down"));
    const result = await publishBiochocoOverview();
    expect(result.success).toBe(false);
    expect(saveReportSnapshot).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    if (!result.success) expect(result.error).toContain("db down");
  });
});
