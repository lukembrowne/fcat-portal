/**
 * Unit tests for the unified image-derivative cache tiers (thumbnail.ts).
 *
 * Covers:
 * - sizedPath puts both tiers in ONE per-deployment dir with distinct filenames
 * - thumb keeps legacy width-only resize; annotate bounds the long edge and
 *   never upscales small originals
 */
import { describe, it, expect, vi } from "vitest";

// Capture the sharp pipeline calls so we can assert per-tier resize args.
const resizeCalls: unknown[][] = [];
vi.mock("sharp", () => ({
  default: vi.fn(() => {
    const chain = {
      resize: vi.fn((...args: unknown[]) => {
        resizeCalls.push(args);
        return chain;
      }),
      jpeg: vi.fn(() => chain),
      toBuffer: vi.fn(async () => Buffer.from("out")),
    };
    return chain;
  }),
}));

const { THUMB_TIER, ANNOTATE_TIER, sizedPath, resizeForTier } = await import(
  "@/lib/thumbnail"
);

describe("derivative tiers", () => {
  it("places both tiers in one deployment dir with distinct names", () => {
    const thumb = sizedPath(THUMB_TIER, 42, 100);
    const annotate = sizedPath(ANNOTATE_TIER, 42, 100);
    // Same parent directory (one cache), different filenames.
    expect(thumb).toMatch(/[/\\]42[/\\]100\.jpg$/);
    expect(annotate).toMatch(/[/\\]42[/\\]100@1920\.jpg$/);
    expect(thumb.replace(/100\.jpg$/, "")).toBe(
      annotate.replace(/100@1920\.jpg$/, ""),
    );
  });

  it("thumb uses width-only resize (legacy, byte-compatible)", async () => {
    resizeCalls.length = 0;
    await resizeForTier(Buffer.from("src"), THUMB_TIER);
    expect(resizeCalls[0]).toEqual([400]);
  });

  it("annotate bounds the long edge and never upscales", async () => {
    resizeCalls.length = 0;
    await resizeForTier(Buffer.from("src"), ANNOTATE_TIER);
    expect(resizeCalls[0]).toEqual([
      1920,
      1920,
      { fit: "inside", withoutEnlargement: true },
    ]);
  });
});
