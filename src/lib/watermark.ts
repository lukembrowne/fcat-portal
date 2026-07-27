import sharp from "sharp";

/**
 * Subtle FCAT/BioChoco watermark composited into the shareable (large) image
 * tier so forwarded photos keep attribution.
 *
 * Bump WATERMARK_VERSION whenever the mark changes — it is part of the on-disk
 * cache key in the site-images route, so a new version invalidates cached
 * watermarked JPEGs without a manual purge.
 */
export const WATERMARK_VERSION = 2;

const WATERMARK_TEXT = "FCAT · BioChocó";

// A rounded translucent plate keeps the text legible on light or dark photos.
// 16px transparent margin on the right / 12px on the bottom becomes the inset
// when composited with gravity "southeast".
function buildSvg(): string {
  return `<svg width="316" height="58" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="300" height="46" rx="8" fill="black" fill-opacity="0.35"/>
  <text x="150" y="30" text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700"
        fill="white" fill-opacity="0.92">${WATERMARK_TEXT}</text>
</svg>`;
}

let cached: Promise<Buffer> | null = null;

/** Rasterize the watermark once (module-cached) and reuse across requests. */
export function getWatermarkOverlay(): Promise<Buffer> {
  if (!cached) {
    cached = sharp(Buffer.from(buildSvg())).png().toBuffer();
  }
  return cached;
}
