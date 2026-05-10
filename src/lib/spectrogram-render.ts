export type RenderArgs = {
  magnitudes: Float32Array;
  numFrames: number;
  binCount: number;
  displayMaxBin: number;
  gainDB: number;
  rangeDB: number;
  lut: Uint8ClampedArray;
};

export type RenderedImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export function renderImageData(args: RenderArgs): RenderedImage {
  const { magnitudes, numFrames, binCount, gainDB, rangeDB, lut } = args;
  const displayMaxBin = Math.max(1, Math.min(args.displayMaxBin, binCount));
  const width = numFrames;
  const height = displayMaxBin;
  const data = new Uint8ClampedArray(width * height * 4);
  const inv = 1 / rangeDB;

  for (let x = 0; x < width; x++) {
    const rowBase = x * binCount;
    for (let y = 0; y < height; y++) {
      const db = magnitudes[rowBase + (height - 1 - y)] + gainDB;
      let t = (db + rangeDB) * inv;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const lutIdx = (t * 255) | 0;
      const li = lutIdx * 3;
      const px = (y * width + x) * 4;
      data[px] = lut[li];
      data[px + 1] = lut[li + 1];
      data[px + 2] = lut[li + 2];
      data[px + 3] = 255;
    }
  }

  return { width, height, data };
}
