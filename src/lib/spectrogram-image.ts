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

/** Render and return a `data:image/png;base64,…` URI, ready to inline in JSON/HTML. */
export async function renderSpectrogramDataUri(
  samples: Float32Array,
  sampleRate: number,
): Promise<string> {
  const png = await renderSpectrogramPng(samples, sampleRate);
  return `data:image/png;base64,${png.toString("base64")}`;
}
