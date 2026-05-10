export type ColormapName = "viridis" | "magma" | "inferno" | "turbo" | "grayscale";

type RGB = readonly [number, number, number];

const VIRIDIS_ANCHORS: readonly RGB[] = [
  [0.267, 0.005, 0.329],
  [0.282, 0.140, 0.458],
  [0.254, 0.265, 0.530],
  [0.207, 0.372, 0.553],
  [0.163, 0.471, 0.558],
  [0.128, 0.567, 0.551],
  [0.135, 0.659, 0.518],
  [0.345, 0.752, 0.412],
  [0.993, 0.906, 0.144],
];

const MAGMA_ANCHORS: readonly RGB[] = [
  [0.001, 0.000, 0.014],
  [0.078, 0.057, 0.222],
  [0.232, 0.060, 0.438],
  [0.394, 0.083, 0.434],
  [0.551, 0.140, 0.418],
  [0.730, 0.215, 0.331],
  [0.882, 0.396, 0.278],
  [0.984, 0.633, 0.408],
  [0.987, 0.991, 0.749],
];

const INFERNO_ANCHORS: readonly RGB[] = [
  [0.001, 0.000, 0.014],
  [0.092, 0.039, 0.249],
  [0.262, 0.039, 0.408],
  [0.413, 0.097, 0.434],
  [0.578, 0.148, 0.404],
  [0.752, 0.225, 0.337],
  [0.890, 0.355, 0.232],
  [0.979, 0.580, 0.196],
  [0.988, 1.000, 0.645],
];

function buildFromAnchors(anchors: readonly RGB[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  const n = anchors.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * n;
    const lo = Math.floor(t);
    const hi = Math.min(lo + 1, n);
    const f = t - lo;
    const a = anchors[lo];
    const b = anchors[hi];
    lut[i * 3] = (a[0] + (b[0] - a[0]) * f) * 255;
    lut[i * 3 + 1] = (a[1] + (b[1] - a[1]) * f) * 255;
    lut[i * 3 + 2] = (a[2] + (b[2] - a[2]) * f) * 255;
  }
  return lut;
}

// Inverted grayscale: low energy = white, high energy = black (Merlin-style).
function buildGrayscale(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = 255 - i;
    lut[i * 3] = v;
    lut[i * 3 + 1] = v;
    lut[i * 3 + 2] = v;
  }
  return lut;
}

// Mikhailov's Turbo polynomial approximation
// https://gist.github.com/mikhailov-work/0d177465a8151eb6ede1768d51d476c7
function buildTurbo(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const t2 = t * t;
    const t3 = t2 * t;
    const t4 = t3 * t;
    const t5 = t4 * t;
    const r = 0.13572138 + 4.6153926 * t - 42.66032258 * t2 + 132.13108234 * t3 - 152.94239396 * t4 + 59.28637943 * t5;
    const g = 0.09140261 + 2.19418839 * t + 4.84296658 * t2 - 14.18503333 * t3 + 4.27729857 * t4 + 2.82956604 * t5;
    const b = 0.1066733 + 12.64194608 * t - 60.58204836 * t2 + 110.36276771 * t3 - 89.90310912 * t4 + 27.34824973 * t5;
    lut[i * 3] = r * 255;
    lut[i * 3 + 1] = g * 255;
    lut[i * 3 + 2] = b * 255;
  }
  return lut;
}

export const COLORMAPS: Record<ColormapName, Uint8ClampedArray> = {
  viridis: buildFromAnchors(VIRIDIS_ANCHORS),
  magma: buildFromAnchors(MAGMA_ANCHORS),
  inferno: buildFromAnchors(INFERNO_ANCHORS),
  turbo: buildTurbo(),
  grayscale: buildGrayscale(),
};

export const COLORMAP_NAMES: readonly ColormapName[] = [
  "viridis",
  "magma",
  "inferno",
  "turbo",
  "grayscale",
];
