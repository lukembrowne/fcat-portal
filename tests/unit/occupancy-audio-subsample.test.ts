import { describe, it, expect, afterEach } from "vitest";
import {
  selectCanonicalAudioFiles,
  type AudioFileRow,
} from "@/lib/occupancy/audio-subsample";

/** Build an audio_files row with a canonical `<serial>_YYYYMMDD_HHMMSS.wav` name. */
function f(id: number, dep: number, ymd: string, hms: string): AudioFileRow {
  return { id, deployment_id: dep, filename: `2MM00000_${ymd}_${hms}.wav` };
}

const D = "20260218";

describe("selectCanonicalAudioFiles — 10-min wall-clock bucketing", () => {
  afterEach(() => {
    delete process.env.OCCUPANCY_AUDIO_SUBSAMPLE_BUCKET_MINUTES;
  });

  it("halves a 5-min deployment to a 10-min cadence (keep earliest per bucket)", () => {
    const files = [
      f(1, 90, D, "100000"),
      f(2, 90, D, "100500"),
      f(3, 90, D, "101000"),
      f(4, 90, D, "101500"),
      f(5, 90, D, "102000"),
      f(6, 90, D, "102500"),
    ];
    const { keptIds, summary } = selectCanonicalAudioFiles(files);
    expect([...keptIds].sort((a, b) => a - b)).toEqual([1, 3, 5]); // :00, :10, :20
    const dep = summary.byDeployment.get(90)!;
    expect(dep.filesKept).toBe(3);
    expect(dep.filesDropped).toBe(3);
    expect(dep.nativeCadenceSeconds).toBe(300);
  });

  it("leaves a 10-min deployment essentially unchanged", () => {
    const files = [f(1, 91, D, "100000"), f(2, 91, D, "101000"), f(3, 91, D, "102000")];
    const { keptIds, summary } = selectCanonicalAudioFiles(files);
    expect(keptIds.size).toBe(3);
    const dep = summary.byDeployment.get(91)!;
    expect(dep.filesDropped).toBe(0);
    expect(dep.nativeCadenceSeconds).toBe(600);
  });

  it("normalizes a phase-offset 5-min recorder to ~10-min", () => {
    // :03,:08 → bucket 0 (keep :03); :13,:18 → bucket 1 (keep :13)
    const files = [
      f(1, 92, D, "100300"),
      f(2, 92, D, "100800"),
      f(3, 92, D, "101300"),
      f(4, 92, D, "101800"),
    ];
    const { keptIds } = selectCanonicalAudioFiles(files);
    expect([...keptIds].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it("normalizes a mixed-cadence deployment without special-casing", () => {
    const files = [
      // morning: 5-min stretch (:00,:05,:10,:15)
      f(1, 110, D, "080000"),
      f(2, 110, D, "080500"),
      f(3, 110, D, "081000"),
      f(4, 110, D, "081500"),
      // afternoon: 10-min stretch (:00,:10,:20)
      f(5, 110, D, "140000"),
      f(6, 110, D, "141000"),
      f(7, 110, D, "142000"),
    ];
    const { keptIds } = selectCanonicalAudioFiles(files);
    // morning halved (:00,:10 → ids 1,3), afternoon untouched (5,6,7)
    expect([...keptIds].sort((a, b) => a - b)).toEqual([1, 3, 5, 6, 7]);
  });

  it("resets buckets per calendar day (near-midnight files are distinct)", () => {
    const files = [f(1, 93, "20260218", "235500"), f(2, 93, "20260219", "000500")];
    const { keptIds } = selectCanonicalAudioFiles(files);
    expect(keptIds.size).toBe(2);
  });

  it("keeps unparseable filenames by default and counts them", () => {
    const files: AudioFileRow[] = [
      f(1, 94, D, "100000"),
      { id: 2, deployment_id: 94, filename: "weird-name-no-timestamp.wav" },
      { id: 3, deployment_id: 94, filename: null },
    ];
    const { keptIds, summary } = selectCanonicalAudioFiles(files);
    expect(keptIds.has(2)).toBe(true);
    expect(keptIds.has(3)).toBe(true);
    const dep = summary.byDeployment.get(94)!;
    expect(dep.filesUnparsed).toBe(2);
  });

  it("surfaces the degenerate case: dense cadence implied but zero drops (all unparseable)", () => {
    const files: AudioFileRow[] = [1, 2, 3, 4].map((id) => ({
      id,
      deployment_id: 95,
      filename: `no_timestamp_here_${id}.wav`,
    }));
    const { summary } = selectCanonicalAudioFiles(files);
    const dep = summary.byDeployment.get(95)!;
    expect(dep.filesDropped).toBe(0);
    expect(dep.filesUnparsed).toBe(4);
    expect(dep.nativeCadenceSeconds).toBeNull();
  });

  it("documents KTD1's caveat: a phase-drifted ~10-min recorder can drop a file", () => {
    // 580s gaps: secs 10, 590, 1170, 1750 → buckets 0,0,1,2 → :00:10 and :09:50 collide
    const files = [
      f(1, 96, D, "000010"),
      f(2, 96, D, "000950"),
      f(3, 96, D, "001930"),
      f(4, 96, D, "002910"),
    ];
    const { summary } = selectCanonicalAudioFiles(files);
    const dep = summary.byDeployment.get(96)!;
    expect(dep.filesDropped).toBe(1); // not the promised zero — the true invariant is <=1/bucket
    expect(dep.nativeCadenceSeconds).toBe(580);
  });

  it("keeps every file when bucketMinutes = 1 (revert lever, via opts)", () => {
    const files = [
      f(1, 97, D, "100000"),
      f(2, 97, D, "100500"),
      f(3, 97, D, "101000"),
    ];
    const { keptIds } = selectCanonicalAudioFiles(files, { bucketMinutes: 1 });
    expect(keptIds.size).toBe(3);
  });

  it("reads the bucket width from the env knob", () => {
    process.env.OCCUPANCY_AUDIO_SUBSAMPLE_BUCKET_MINUTES = "1";
    const files = [f(1, 98, D, "100000"), f(2, 98, D, "100500")];
    const { keptIds, summary } = selectCanonicalAudioFiles(files);
    expect(keptIds.size).toBe(2);
    expect(summary.bucketMinutes).toBe(1);
  });

  it("reconciles totals: filesTotal = kept + dropped + unparsed", () => {
    const files: AudioFileRow[] = [
      f(1, 90, D, "100000"),
      f(2, 90, D, "100500"),
      f(3, 90, D, "101000"),
      { id: 4, deployment_id: 90, filename: "bad.wav" },
    ];
    const { summary } = selectCanonicalAudioFiles(files);
    const dep = summary.byDeployment.get(90)!;
    expect(dep.filesTotal).toBe(dep.filesKept + dep.filesDropped);
    // filesKept already includes the kept-by-default unparsed file
    expect(dep.filesUnparsed).toBe(1);
    expect(summary.filesTotal).toBe(summary.filesKept + summary.filesDropped);
    expect(summary.filesKept).toBe(3); // :00, :10, + the unparsed kept file
  });
});
