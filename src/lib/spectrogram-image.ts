/**
 * Server-side spectrogram PNG renderer.
 *
 * Reuses the exact same pure-JS primitives as the browser spectrogram
 * (`computeMagnitudes` → `renderImageData`, with `COLORMAPS.magma`) so a
 * pre-rendered image matches what the client FFT would have drawn, then encodes
 * the RGBA pixels to a PNG with `sharp`. Used at publish time to cache each
 * curated clip's spectrogram in the snapshot, so the public page shows an
 * `<img>` instead of decoding + FFT-ing audio on every load (and so it works on
 * iOS/Safari, which can't `decodeAudioData` FLAC).
 *
 * The render knobs here MUST mirror `spectrogram-clip.tsx` so cached and
 * client-generated images look identical.
 */

import "server-only";

import sharp from "sharp";
import { computeMagnitudes, binFromHz } from "./audio-fft";
import { renderImageData } from "./spectrogram-render";
import { COLORMAPS } from "./spectrogram-colormaps";

// Mirror of the client render knobs (spectrogram-clip.tsx).
const DISPLAY_MAX_HZ = 12000;
const FFT_SIZE = 1024;
const GAIN_DB = 18;
const RANGE_DB = 72;

// The raw FFT bitmap is one pixel per frame — a 60 s clip at 48 kHz is
// 5624 x 257 px, ~1.5 MB as PNG, painted into a ~450 x 132 CSS box. Encode at
// 2x the widest the clip is ever displayed at (the one-column mobile layout,
// ~920 px) so it stays crisp on retina, and use WebP: on this noisy, colourful
// content PNG costs ~1 byte/px while WebP costs ~0.15. Together that is ~1.5 MB
// -> ~70 KB per clip.
//
// `fit: "fill"` (not "inside") is deliberate: both the client canvas and the
// <img> stretch the bitmap to the box without preserving its aspect ratio, so
// the cached image has to be distorted the same way to look identical.
const OUT_WIDTH = 1600;
const OUT_HEIGHT = 264;
const OUT_QUALITY = 80;

/** Render a mono PCM buffer to a magma spectrogram PNG. */
export async function renderSpectrogramPng(
  samples: Float32Array,
  sampleRate: number,
): Promise<Buffer> {
  const mags = computeMagnitudes({
    samples,
    sampleRate,
    fftSize: FFT_SIZE,
    hopSize: FFT_SIZE / 2,
  });
  const displayMaxBin = Math.min(
    mags.binCount,
    binFromHz(DISPLAY_MAX_HZ, mags.fftSize, mags.sampleRate) + 1,
  );
  const img = renderImageData({
    magnitudes: mags.magnitudes,
    numFrames: mags.numFrames,
    binCount: mags.binCount,
    displayMaxBin,
    gainDB: GAIN_DB,
    rangeDB: RANGE_DB,
    lut: COLORMAPS.magma,
  });

  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/**
 * Render a display-sized WebP of the spectrogram: the full-resolution FFT
 * bitmap downscaled to the box it is actually painted into. This is what gets
 * stored in the snapshot and served to browsers.
 */
export async function renderSpectrogramWeb(
  samples: Float32Array,
  sampleRate: number,
): Promise<Buffer> {
  const full = await renderSpectrogramPng(samples, sampleRate);
  return sharp(full)
    .resize({ width: OUT_WIDTH, height: OUT_HEIGHT, fit: "fill" })
    .webp({ quality: OUT_QUALITY })
    .toBuffer();
}

/** Render and return a `data:image/webp;base64,…` URI, ready to store in the snapshot. */
export async function renderSpectrogramDataUri(
  samples: Float32Array,
  sampleRate: number,
): Promise<string> {
  const img = await renderSpectrogramWeb(samples, sampleRate);
  return `data:image/webp;base64,${img.toString("base64")}`;
}
