import FFT from "fft.js";

export type DecodedAudio = {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
};

export type ComputeArgs = {
  samples: Float32Array;
  sampleRate: number;
  fftSize: number;
  hopSize: number;
};

export type Magnitudes = {
  magnitudes: Float32Array;
  numFrames: number;
  binCount: number;
  sampleRate: number;
  fftSize: number;
  hopSize: number;
};

const DB_FLOOR = -120;
const MAG_EPSILON = 1e-12;
const hannCache = new Map<number, Float32Array>();

function getHannWindow(size: number): Float32Array {
  const cached = hannCache.get(size);
  if (cached) return cached;
  const w = new Float32Array(size);
  const denom = size - 1;
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  }
  hannCache.set(size, w);
  return w;
}

function isPowerOfTwo(n: number): boolean {
  return n >= 2 && (n & (n - 1)) === 0;
}

export async function decodeAudio(url: string): Promise<DecodedAudio> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch audio (${res.status})`);
  }
  const buffer = await res.arrayBuffer();

  const Ctor =
    (typeof window !== "undefined" && (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)) ||
    null;
  if (!Ctor) {
    throw new Error("AudioContext not available");
  }
  const ctx = new Ctor();
  try {
    const audioBuffer = await ctx.decodeAudioData(buffer);
    const { sampleRate, duration, numberOfChannels, length } = audioBuffer;
    const mono = new Float32Array(length);
    if (numberOfChannels === 1) {
      mono.set(audioBuffer.getChannelData(0));
    } else {
      const inv = 1 / numberOfChannels;
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = 0; i < length; i++) mono[i] += data[i] * inv;
      }
    }
    return { samples: mono, sampleRate, duration };
  } finally {
    void ctx.close();
  }
}

export function computeMagnitudes(args: ComputeArgs): Magnitudes {
  const { samples, sampleRate, fftSize, hopSize } = args;
  if (!isPowerOfTwo(fftSize)) {
    throw new Error(`fftSize must be a power of two ≥ 2, got ${fftSize}`);
  }
  if (hopSize <= 0 || hopSize > fftSize) {
    throw new Error(`hopSize must be in (0, fftSize], got ${hopSize}`);
  }

  const binCount = fftSize / 2 + 1;
  const numFrames = Math.max(1, Math.floor((samples.length - fftSize) / hopSize) + 1);
  const magnitudes = new Float32Array(numFrames * binCount);

  const fft = new FFT(fftSize);
  const out = fft.createComplexArray();
  const window = getHannWindow(fftSize);
  const frame = new Float32Array(fftSize);

  for (let f = 0; f < numFrames; f++) {
    const offset = f * hopSize;
    const end = Math.min(offset + fftSize, samples.length);
    const copyLen = end - offset;
    for (let i = 0; i < copyLen; i++) frame[i] = samples[offset + i] * window[i];
    if (copyLen < fftSize) {
      for (let i = copyLen; i < fftSize; i++) frame[i] = 0;
    }

    fft.realTransform(out, frame);

    const rowBase = f * binCount;
    for (let b = 0; b < binCount; b++) {
      const re = out[b * 2];
      const im = out[b * 2 + 1];
      const mag = Math.sqrt(re * re + im * im);
      const db = 20 * Math.log10(mag + MAG_EPSILON);
      magnitudes[rowBase + b] = db < DB_FLOOR ? DB_FLOOR : db;
    }
  }

  return { magnitudes, numFrames, binCount, sampleRate, fftSize, hopSize };
}

export function binFromHz(hz: number, fftSize: number, sampleRate: number): number {
  return Math.round((hz * fftSize) / sampleRate);
}

export function hzFromBin(bin: number, fftSize: number, sampleRate: number): number {
  return (bin * sampleRate) / fftSize;
}
