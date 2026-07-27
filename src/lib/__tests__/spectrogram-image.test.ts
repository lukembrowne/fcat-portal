/**
 * Unit test for the server-side spectrogram PNG renderer. Feeds a synthetic
 * mono PCM buffer (a pure tone) through the real render pipeline — the same
 * primitives the client uses (`computeMagnitudes` → `renderImageData`) plus
 * `sharp` PNG encoding — and asserts the output is a PNG of the expected
 * dimensions. Deterministic: no Drive, no ffmpeg.
 */

import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { renderSpectrogramPng, renderSpectrogramWeb } from "../spectrogram-image";

/** One second of a 1 kHz sine at the given sample rate. */
function sine(freqHz: number, seconds: number, sampleRate: number): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return s;
}

/** A broadband sweep + noise — closer to a field recording than a pure tone. */
function fieldish(seconds: number, sampleRate: number): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const s = new Float32Array(n);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    s[i] = 0.3 * Math.sin(2 * Math.PI * (800 + 3000 * Math.sin(t)) * t) + 0.15 * rand();
  }
  return s;
}

describe("renderSpectrogramPng", () => {
  it("encodes a PNG whose dimensions match the FFT frame/bin geometry", async () => {
    const sampleRate = 48000;
    const samples = sine(1000, 1, sampleRate);

    const png = await renderSpectrogramPng(samples, sampleRate);
    const meta = await sharp(png).metadata();

    expect(meta.format).toBe("png");
    // width = number of FFT frames = floor((N - fftSize)/hop) + 1, fftSize=1024, hop=512
    const expectedFrames = Math.floor((samples.length - 1024) / 512) + 1;
    expect(meta.width).toBe(expectedFrames);
    // height = displayMaxBin = binFromHz(12000,1024,48000)+1 = 256 + 1
    expect(meta.height).toBe(257);
  });

  it("returns a non-trivial buffer (the tone lights up bins)", async () => {
    const png = await renderSpectrogramPng(sine(2000, 0.5, 48000), 48000);
    expect(png.length).toBeGreaterThan(100);
  });
});

describe("renderSpectrogramWeb", () => {
  it("downscales to the fixed display box regardless of clip length", async () => {
    for (const seconds of [1, 10]) {
      const meta = await sharp(
        await renderSpectrogramWeb(fieldish(seconds, 48000), 48000),
      ).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(1600);
      expect(meta.height).toBe(264);
    }
  });

  it("is drastically smaller than the raw FFT bitmap", async () => {
    // The regression this guards: a full-resolution 60 s spectrogram is ~1.5 MB
    // of PNG, and six of them inlined as base64 made the public page a 21 MB
    // document. Anything near the old size means the downscale stopped running.
    const samples = fieldish(60, 48000);
    const full = await renderSpectrogramPng(samples, 48000);
    const web = await renderSpectrogramWeb(samples, 48000);

    expect((await sharp(full).metadata()).width).toBeGreaterThan(5000);
    expect(web.length).toBeLessThan(250 * 1024);
    expect(web.length).toBeLessThan(full.length / 5);
  });
});
