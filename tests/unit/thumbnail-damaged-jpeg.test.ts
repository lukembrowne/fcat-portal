import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { resizeForTier, THUMB_TIER, ANNOTATE_TIER } from "@/lib/thumbnail";
import { TOLERANT_DECODE } from "@/lib/image-decode";

/**
 * Regression cover for the POT-001 / POT-003 outage.
 *
 * Those cameras wrote JPEGs whose entropy-coded scan data ends early: the file is
 * intact on Drive (md5 + size match, valid ffd8…ffd9 markers) but libjpeg raises
 * "Corrupt JPEG data: premature end of data segment" decoding the final MCUs.
 * sharp's default `failOn: "warning"` turned that into a hard throw, so every
 * thumbnail and annotate-tier derivative failed and the viewer showed a broken
 * image behind a misleading `{"error":"Drive API error"}` 502.
 */

/** A real JPEG whose scan data is cut short but which still ends with EOI. */
function damage(jpeg: Buffer): Buffer {
  // Start of Scan; entropy-coded data follows its header.
  const sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  expect(sos).toBeGreaterThan(0);
  const headerLen = jpeg.readUInt16BE(sos + 2);
  const scanStart = sos + 2 + headerLen;
  // Keep a third of the scan, then terminate the file properly, exactly like the
  // affected camera files: truncated payload, structurally valid container.
  const cut = scanStart + Math.floor((jpeg.length - scanStart) / 3);
  return Buffer.concat([jpeg.subarray(0, cut), Buffer.from([0xff, 0xd9])]);
}

let healthy: Buffer;
let damaged: Buffer;

beforeAll(async () => {
  // Noise, not flat colour — a flat image compresses so well that lopping off
  // two-thirds of the scan still decodes cleanly and the test would prove nothing.
  const width = 600;
  const height = 400;
  const noise = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 251;

  healthy = await sharp(noise, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
  damaged = damage(healthy);
});

describe("damaged camera-trap JPEG decoding", () => {
  it("the fixture actually trips libjpeg under sharp's default failOn", async () => {
    // Guards the test itself: if this stops throwing, the fixture no longer
    // reproduces the field condition and the assertions below are vacuous.
    await expect(
      sharp(damaged).resize(320).jpeg().toBuffer(),
    ).rejects.toThrow(/premature end|Corrupt JPEG/i);
  });

  it("decodes the damaged frame with the tolerant options", async () => {
    const out = await sharp(damaged, TOLERANT_DECODE).resize(320).jpeg().toBuffer();
    expect((await sharp(out).metadata()).width).toBe(320);
  });

  it("still rejects a genuinely truncated buffer (no EOI at all)", async () => {
    // The reason for failOn:"truncated" over failOn:"none" — a half-finished
    // Drive download must not be silently baked into the derivative cache.
    const halfDownload = healthy.subarray(0, Math.floor(healthy.length / 2));
    await expect(
      sharp(halfDownload, TOLERANT_DECODE).resize(320).jpeg().toBuffer(),
    ).rejects.toThrow();
  });

  it("resizeForTier produces a thumbnail from a damaged frame", async () => {
    const out = await resizeForTier(damaged, THUMB_TIER);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(THUMB_TIER.longEdge);
  });

  it("resizeForTier produces the annotate tier from a damaged frame", async () => {
    const out = await resizeForTier(damaged, ANNOTATE_TIER);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    // 600x400 source, bounded long edge, never upscaled.
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
  });

  it("leaves healthy frames byte-identical to the previous pipeline", async () => {
    const viaTier = await resizeForTier(healthy, THUMB_TIER);
    const viaLegacy = await sharp(healthy)
      .resize(THUMB_TIER.longEdge)
      .jpeg({ quality: THUMB_TIER.quality })
      .toBuffer();
    expect(viaTier.equals(viaLegacy)).toBe(true);
  });
});
