import { describe, it, expect } from "vitest";
import {
  evaluateAudioBatchEligibility,
  isWithinEcuadorNightWindow,
  SETTLE_QUIET_HOURS,
  type AudioBatchCandidate,
} from "@/lib/audio-batch-eligibility";

// Fixed "now" = 2026-06-17 12:00:00 UTC (07:00 Ecuador). Used for settle math.
const NOW = Date.parse("2026-06-17T12:00:00Z");

function candidate(overrides: Partial<AudioBatchCandidate> = {}): AudioBatchCandidate {
  return {
    id: 1,
    uploadAudioFolderId: "folder-abc",
    audioFileCount: 500,
    isBirdnetProcessing: 0,
    lastBirdnetAtSeconds: null, // never processed
    uploadAudioCount: 500,
    previousAudioCount: 500,
    // 48h before NOW → comfortably past the 24h quiet threshold
    uploadNewestAudioDate: new Date(NOW - 48 * 3_600_000).toISOString(),
    excluded: false,
    ...overrides,
  };
}

describe("isWithinEcuadorNightWindow", () => {
  // Ecuador is UTC-5. Window is 22:00–06:00 Ecuador, crossing midnight.
  const ecuadorAt = (hour: number, min = 0) =>
    new Date(Date.UTC(2026, 5, 17, (hour + 5) % 24, min)); // +5 → UTC

  it("is true at 22:00 Ecuador (window opens)", () => {
    expect(isWithinEcuadorNightWindow(ecuadorAt(22))).toBe(true);
  });
  it("is false at 21:59 Ecuador (just before open)", () => {
    expect(isWithinEcuadorNightWindow(ecuadorAt(21, 59))).toBe(false);
  });
  it("is true across midnight (02:00 Ecuador)", () => {
    expect(isWithinEcuadorNightWindow(ecuadorAt(2))).toBe(true);
  });
  it("is true at 05:59 Ecuador (just before close)", () => {
    expect(isWithinEcuadorNightWindow(ecuadorAt(5, 59))).toBe(true);
  });
  it("is false at 06:00 Ecuador (window closes)", () => {
    expect(isWithinEcuadorNightWindow(ecuadorAt(6))).toBe(false);
  });
  it("is false at noon Ecuador", () => {
    expect(isWithinEcuadorNightWindow(ecuadorAt(12))).toBe(false);
  });
});

describe("evaluateAudioBatchEligibility", () => {
  it("accepts a never-processed, settled deployment", () => {
    const r = evaluateAudioBatchEligibility(candidate(), NOW);
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(r.audioFolderId).toBe("folder-abc");
      expect(r.cachedAudioCount).toBe(500);
    }
  });

  it("rejects excluded deployments", () => {
    const r = evaluateAudioBatchEligibility(candidate({ excluded: true }), NOW);
    expect(r).toMatchObject({ eligible: false, reason: "excluded" });
  });

  it("rejects deployments with no synced audio", () => {
    expect(evaluateAudioBatchEligibility(candidate({ audioFileCount: 0 }), NOW))
      .toMatchObject({ eligible: false, reason: "no_audio" });
    expect(evaluateAudioBatchEligibility(candidate({ uploadAudioFolderId: null }), NOW))
      .toMatchObject({ eligible: false, reason: "no_audio" });
  });

  it("rejects deployments already queued/running", () => {
    const r = evaluateAudioBatchEligibility(candidate({ isBirdnetProcessing: 1 }), NOW);
    expect(r).toMatchObject({ eligible: false, reason: "in_flight" });
  });

  it("rejects already-processed deployments (reprocess is a later phase)", () => {
    // lastBirdnetAt is SECONDS at runtime — a recent value must be read correctly,
    // not mistaken for 1970 (the seconds-vs-ms gotcha).
    const r = evaluateAudioBatchEligibility(
      candidate({ lastBirdnetAtSeconds: Math.floor(NOW / 1000) - 3600 }),
      NOW,
    );
    expect(r).toMatchObject({ eligible: false, reason: "already_processed" });
  });

  it("rejects when count snapshots are missing", () => {
    expect(evaluateAudioBatchEligibility(candidate({ uploadAudioCount: null }), NOW))
      .toMatchObject({ eligible: false, reason: "null_counts" });
    expect(evaluateAudioBatchEligibility(candidate({ previousAudioCount: null }), NOW))
      .toMatchObject({ eligible: false, reason: "null_counts" });
  });

  it("rejects a malformed newest-file date (no silent NaN)", () => {
    const r = evaluateAudioBatchEligibility(
      candidate({ uploadNewestAudioDate: "not-a-date" }),
      NOW,
    );
    expect(r).toMatchObject({ eligible: false, reason: "null_counts" });
  });

  it("rejects when the count changed since last refresh (still uploading)", () => {
    const r = evaluateAudioBatchEligibility(
      candidate({ uploadAudioCount: 520, previousAudioCount: 500 }),
      NOW,
    );
    expect(r).toMatchObject({ eligible: false, reason: "unsettled" });
  });

  it("rejects when the newest file is too fresh (< quiet hours)", () => {
    const r = evaluateAudioBatchEligibility(
      candidate({
        uploadNewestAudioDate: new Date(NOW - (SETTLE_QUIET_HOURS - 1) * 3_600_000).toISOString(),
      }),
      NOW,
    );
    expect(r).toMatchObject({ eligible: false, reason: "unsettled" });
  });

  it("accepts exactly at the quiet threshold boundary", () => {
    const r = evaluateAudioBatchEligibility(
      candidate({
        uploadNewestAudioDate: new Date(NOW - SETTLE_QUIET_HOURS * 3_600_000).toISOString(),
      }),
      NOW,
    );
    expect(r.eligible).toBe(true);
  });
});
