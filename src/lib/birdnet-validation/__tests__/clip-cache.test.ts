import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/drive-client", () => ({ downloadFile: vi.fn() }));
vi.mock("@/lib/spectrogram-image", () => ({ renderSpectrogramPng: vi.fn() }));
vi.mock("@/lib/audio-pcm", () => ({ decodeLocalAudioToPcmMono: vi.fn() }));

const { clipWindow, CLIP_PADDING_SECONDS } = await import("../clip-cache");

describe("clipWindow", () => {
  it("pads the detection on both sides", () => {
    const win = clipWindow({ startTime: 20, endTime: 23, duration: 60 });
    expect(win.start).toBe(20 - CLIP_PADDING_SECONDS);
    expect(win.end).toBe(23 + CLIP_PADDING_SECONDS);
  });

  it("clamps the start to 0 for a detection near the beginning", () => {
    // Would otherwise produce a negative ffmpeg -ss.
    const win = clipWindow({ startTime: 0.5, endTime: 3.5, duration: 60 });
    expect(win.start).toBe(0);
    expect(win.end).toBeCloseTo(6.5, 6);
  });

  it("clamps the end to the file duration for a detection near the end", () => {
    const win = clipWindow({ startTime: 56, endTime: 59.5, duration: 60 });
    expect(win.end).toBe(60);
    expect(win.start).toBe(53);
  });

  it("leaves the end unclamped when duration is unknown", () => {
    const win = clipWindow({ startTime: 56, endTime: 59.5, duration: null });
    expect(win.end).toBeCloseTo(62.5, 6);
  });

  it("ignores a zero or negative duration rather than collapsing the window", () => {
    const win = clipWindow({ startTime: 10, endTime: 13, duration: 0 });
    expect(win.start).toBe(7);
    expect(win.end).toBe(16);
  });

  it("still yields a listenable window when detection bounds are inverted", () => {
    // Defensive: bad bounds must not produce a zero-length or negative -t.
    const win = clipWindow({ startTime: 30, endTime: 10, duration: 60 });
    expect(win.end).toBeGreaterThan(win.start);
  });

  it("covers the whole file when the detection spans it", () => {
    const win = clipWindow({ startTime: 0, endTime: 60, duration: 60 });
    expect(win.start).toBe(0);
    expect(win.end).toBe(60);
  });
});
