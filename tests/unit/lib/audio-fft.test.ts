import { describe, it, expect } from "vitest";
import { computeMagnitudes, binFromHz, hzFromBin } from "@/lib/audio-fft";
import { synthSineSamples } from "../../helpers/synth-sine";

describe("audio-fft", () => {
  it("places a 440 Hz sine peak at the expected bin", () => {
    const sampleRate = 24000;
    const fftSize = 1024;
    const hopSize = 512;
    const samples = synthSineSamples(440, 1, sampleRate);
    const result = computeMagnitudes({ samples, sampleRate, fftSize, hopSize });

    expect(result.binCount).toBe(fftSize / 2 + 1);
    expect(result.numFrames).toBeGreaterThan(40);
    expect(result.magnitudes.length).toBe(result.numFrames * result.binCount);

    const expectedBin = binFromHz(440, fftSize, sampleRate);
    const midFrame = Math.floor(result.numFrames / 2);
    const rowBase = midFrame * result.binCount;

    let peakBin = 0;
    let peakDb = -Infinity;
    for (let b = 0; b < result.binCount; b++) {
      const db = result.magnitudes[rowBase + b];
      if (db > peakDb) {
        peakDb = db;
        peakBin = b;
      }
    }

    expect(Math.abs(peakBin - expectedBin)).toBeLessThanOrEqual(1);
    expect(peakDb).toBeGreaterThan(-20);

    const dcDb = result.magnitudes[rowBase];
    expect(peakDb).toBeGreaterThan(dcDb + 30);
  });

  it("clamps silence to the dB floor", () => {
    const samples = new Float32Array(4096);
    const result = computeMagnitudes({ samples, sampleRate: 24000, fftSize: 512, hopSize: 256 });
    for (let i = 0; i < result.magnitudes.length; i++) {
      expect(result.magnitudes[i]).toBe(-120);
    }
  });

  it("rejects invalid fftSize", () => {
    const samples = new Float32Array(4096);
    expect(() =>
      computeMagnitudes({ samples, sampleRate: 24000, fftSize: 1000, hopSize: 256 })
    ).toThrow(/power of two/);
  });

  it("rejects invalid hopSize", () => {
    const samples = new Float32Array(4096);
    expect(() =>
      computeMagnitudes({ samples, sampleRate: 24000, fftSize: 1024, hopSize: 2048 })
    ).toThrow(/hopSize/);
  });

  it("hzFromBin and binFromHz round-trip near integer bins", () => {
    const fftSize = 1024;
    const sampleRate = 24000;
    const bin = 100;
    const hz = hzFromBin(bin, fftSize, sampleRate);
    expect(binFromHz(hz, fftSize, sampleRate)).toBe(bin);
  });
});
