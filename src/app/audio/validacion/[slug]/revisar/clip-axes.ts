/**
 * Tick math for the review clip's time and frequency axes.
 *
 * WHY. A reviewer separating two species that sound alike is reading the
 * picture, not just listening to it: where the call sits in frequency and how
 * long its notes are. Without axes the spectrogram carries neither number — the
 * image is stretched to whatever box it lands in (`fit: "fill"`, see
 * `spectrogram-image.ts`), so nothing on screen says whether a band is at 3 kHz
 * or at 7, or whether a trill's notes are 80 ms or 300 ms apart. Requested by a
 * collaborator working exactly that problem.
 *
 * TIME IS MEASURED FROM THE START OF THE CLIP, not from the start of the
 * recording. That is the timeline the playhead, the detection band and the
 * length readout already share (`useClipDuration` → `audio.duration`), and a
 * second origin on the same picture would be read wrong by whoever did not know
 * there were two.
 *
 * Pure — no React, no DOM — so the step choices are unit-testable under
 * vitest's node environment. Rendering lives in `spectrogram-overlay.tsx`.
 */

/** Width of the frequency gutter to the left of the clip, in px. */
export const FREQ_AXIS_WIDTH = 46;

/** Height of the time ruler under the clip, in px. */
export const TIME_AXIS_HEIGHT = 20;

/**
 * The requested increment: 2 kHz.
 *
 * It is the right grain for every ceiling a reviewer actually picks (6, 9 or
 * 12 kHz — see `MAX_HZ_PRESETS`): six lines over a 300 px box, far enough apart
 * to read a label between them. The branches in `freqStepHz` exist only for the
 * two ends this step cannot serve — a 3 kHz ceiling would print two labels, and
 * a 48 kHz recorder's Nyquist ceiling would print thirteen.
 */
export const FREQ_STEP_HZ = 2000;

export interface FreqTick {
  hz: number;
  /** Distance from the TOP of the clip box, as a percentage. */
  topPct: number;
  label: string;
}

export interface TimeTick {
  seconds: number;
  /** Distance from the LEFT edge of the clip, as a percentage. */
  leftPct: number;
  label: string;
}

export function freqStepHz(maxHz: number): number {
  if (!Number.isFinite(maxHz) || maxHz <= 0) return FREQ_STEP_HZ;
  if (maxHz <= 2500) return 500;
  if (maxHz <= 5000) return 1000;
  if (maxHz <= 16000) return FREQ_STEP_HZ;
  if (maxHz <= 32000) return 4000;
  return 8000;
}

/**
 * Ticks from 0 up to the clip's ceiling, ascending.
 *
 * `maxHz` is the frequency at the TOP of the rendered image, which is not
 * always the ceiling the reviewer chose: the renderer clamps to the clip's own
 * bin count, so a 12 kHz setting on a 16 kHz recording paints 8 kHz. The caller
 * passes what was actually painted — a label is a claim about the picture.
 *
 * The topmost label carries the unit, the rest are bare numbers: "12 kHz, 10,
 * 8, …" reads as one axis, while repeating the unit seven times in a narrow
 * gutter reads as noise. `FREQ_AXIS_WIDTH` is sized for that one long label —
 * at 40 px "12 kHz" wrapped onto two lines.
 */
export function freqTicks(maxHz: number): FreqTick[] {
  if (!Number.isFinite(maxHz) || maxHz <= 0) return [];

  const step = freqStepHz(maxHz);
  const count = Math.floor(maxHz / step);
  const ticks: FreqTick[] = [];
  for (let i = 0; i <= count; i++) {
    // i * step rather than an accumulator: 0.1 + 0.1 + … drifts, and a tick at
    // 5999.999999 Hz formats as "6" but sits a hair off its gridline.
    const hz = i * step;
    ticks.push({
      hz,
      topPct: (1 - hz / maxHz) * 100,
      label: formatKHz(hz),
    });
  }
  // The unit rides the topmost tick, which is the last element.
  const top = ticks[ticks.length - 1];
  if (top) top.label = `${top.label} kHz`;
  return ticks;
}

function formatKHz(hz: number): string {
  const kHz = hz / 1000;
  return kHz % 1 === 0 ? String(kHz) : kHz.toFixed(1);
}

/**
 * Candidate spacings, coarsest last. A validation clip is ~9 s (detection ±3 s)
 * and the reviewer can zoom to 4×, so the useful range runs from a tenth of a
 * second to a couple of seconds; the rest are there so nothing degenerates on a
 * clip cut from an unusual window.
 */
const TIME_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60] as const;

/**
 * Roughly the width of the longest label ("0.25 s", ~34 px) plus breathing
 * room. Below this the labels touch, which is less readable than fewer of them.
 * Not more generous than that: at 64 px a phone-width clip fell all the way
 * back to a tick every 5 seconds, which on a 9 s clip is two labels.
 */
const MIN_TICK_SPACING_PX = 52;

/**
 * The finest step whose ticks stay `MIN_TICK_SPACING_PX` apart at this width.
 *
 * `widthPx` is the width the clip is PAINTED at, so it already includes zoom:
 * at 4× the same nine seconds get four times the pixels and earn a finer grid.
 * Returns null when the duration is not yet known (metadata has not loaded) or
 * the box has not been measured, so the caller renders an empty ruler rather
 * than a ruler of NaNs.
 */
export function timeStepSeconds(
  durationSeconds: number | null | undefined,
  widthPx: number | null | undefined
): number | null {
  if (
    durationSeconds == null ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    widthPx == null ||
    !Number.isFinite(widthPx) ||
    widthPx <= 0
  ) {
    return null;
  }
  const pxPerSecond = widthPx / durationSeconds;
  for (const step of TIME_STEPS) {
    if (step * pxPerSecond >= MIN_TICK_SPACING_PX) return step;
  }
  return TIME_STEPS[TIME_STEPS.length - 1];
}

/** Ticks from 0 to the end of the clip, ascending. */
export function timeTicks(
  durationSeconds: number | null | undefined,
  widthPx: number | null | undefined
): TimeTick[] {
  const step = timeStepSeconds(durationSeconds, widthPx);
  if (step == null || durationSeconds == null) return [];

  const decimals = decimalsOf(step);
  const count = Math.floor(durationSeconds / step + 1e-9);
  const ticks: TimeTick[] = [];
  for (let i = 0; i <= count; i++) {
    const seconds = i * step;
    ticks.push({
      seconds,
      leftPct: (seconds / durationSeconds) * 100,
      label: `${seconds === 0 ? "0" : seconds.toFixed(decimals)} s`,
    });
  }
  return ticks;
}

/** Decimals needed to print this step exactly — 0.25 needs two, 0.5 needs one. */
function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}
