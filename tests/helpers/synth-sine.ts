export function synthSineSamples(
  freqHz: number,
  durationSec: number,
  sampleRate: number,
  amplitude = 1
): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freqHz) / sampleRate;
  for (let i = 0; i < n; i++) out[i] = Math.sin(w * i) * amplitude;
  return out;
}
