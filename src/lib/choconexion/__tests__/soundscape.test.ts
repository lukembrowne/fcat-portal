import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import {
  CLIP_SECONDS,
  SOUNDSCAPE_DIEL_PERIODS,
  exportSiteSoundscapes,
  selectSoundscape,
  soundscapeTimestamp,
  type SoundscapeCandidate,
} from "../soundscape";

const run = promisify(execFile);

let nextId = 500;
const cand = (over: Partial<SoundscapeCandidate> = {}): SoundscapeCandidate => ({
  audioFileId: nextId++,
  driveFileId: `drive-${nextId}`,
  filename: "2MM20635_20260422_052500.wav",
  dielPeriod: "dawn",
  acousticComplexityIndex: 200,
  recordedDate: "2026-04-22",
  ...over,
});

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chocon-audio-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

/** A real 90-second WAV, so the cut and encode run for real. */
async function toneWav(dir: string, seconds = 90): Promise<Buffer> {
  const wav = path.join(dir, "tone.wav");
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-ar", "22050", "-ac", "1", wav,
  ]);
  const buf = await fs.readFile(wav);
  await fs.unlink(wav);
  return buf;
}

describe("selectSoundscape", () => {
  it("picks the highest acoustic complexity", () => {
    const best = cand({ acousticComplexityIndex: 340 });
    const picked = selectSoundscape(
      [
        cand({ acousticComplexityIndex: 200 }),
        best,
        cand({ acousticComplexityIndex: 310 }),
      ],
      "dawn",
    );
    expect(picked?.audioFileId).toBe(best.audioFileId);
  });

  it("is reproducible: the same input picks the same recording", () => {
    const pool = [
      cand({ acousticComplexityIndex: 210 }),
      cand({ acousticComplexityIndex: 340 }),
      cand({ acousticComplexityIndex: 190 }),
    ];
    expect(selectSoundscape(pool, "dawn")?.audioFileId).toBe(
      selectSoundscape([...pool].reverse(), "dawn")?.audioFileId,
    );
  });

  it("breaks a tie on audio file id, ascending", () => {
    const low = cand({ audioFileId: 10, acousticComplexityIndex: 300 });
    const high = cand({ audioFileId: 99, acousticComplexityIndex: 300 });
    expect(selectSoundscape([high, low], "dawn")?.audioFileId).toBe(10);
    expect(selectSoundscape([low, high], "dawn")?.audioFileId).toBe(10);
  });

  it("never picks outside the requested period, even at higher complexity", () => {
    // The whole point of fixing the period is that a site's dawn clip is dawn.
    // A louder night recording is a different question, and has its own clip.
    const loudNight = cand({ dielPeriod: "night", acousticComplexityIndex: 900 });
    const quietDawn = cand({ dielPeriod: "dawn", acousticComplexityIndex: 100 });
    expect(selectSoundscape([loudNight, quietDawn], "dawn")?.audioFileId).toBe(
      quietDawn.audioFileId,
    );
    expect(selectSoundscape([loudNight, quietDawn], "night")?.audioFileId).toBe(
      loudNight.audioFileId,
    );
  });

  it("returns null when the site has nothing in that period", () => {
    expect(
      selectSoundscape(
        [cand({ dielPeriod: "night" }), cand({ dielPeriod: "midday" })],
        "dusk",
      ),
    ).toBeNull();
  });

  it("never picks an `other`-period recording", () => {
    // `other` is every hour outside the four named windows — not a time of day
    // anyone asks to hear, and never offered as a chip.
    for (const period of SOUNDSCAPE_DIEL_PERIODS) {
      expect(
        selectSoundscape([cand({ dielPeriod: "other", acousticComplexityIndex: 900 })], period),
      ).toBeNull();
    }
  });

  it("returns null for a site with no acoustic indices at all", () => {
    // P08 has no audio; P12's is unprocessed.
    expect(selectSoundscape([], "dawn")).toBeNull();
  });

  it("skips candidates with no Drive file or no complexity value", () => {
    expect(selectSoundscape([cand({ driveFileId: null })], "dawn")).toBeNull();
    expect(selectSoundscape([cand({ acousticComplexityIndex: null })], "dawn")).toBeNull();
    expect(selectSoundscape([cand({ acousticComplexityIndex: NaN })], "dawn")).toBeNull();
  });
});

describe("soundscapeTimestamp", () => {
  it("reads the recording time from the filename, not the upload date", () => {
    // audio_files.modified_at is the upload date for the deployments that came
    // in through the Drive web UI, which would label the clip years wrong.
    expect(soundscapeTimestamp(cand({ filename: "2MM20635_20260422_052500.wav" }))).toEqual({
      date: "2026-04-22",
      time: "05:25",
    });
  });

  it("handles a FLAC filename the same way", () => {
    expect(soundscapeTimestamp(cand({ filename: "2MM20929_20260503_053500.flac" }))).toEqual({
      date: "2026-05-03",
      time: "05:35",
    });
  });

  it("falls back to the indexed date when the filename carries no timestamp", () => {
    const result = soundscapeTimestamp(
      cand({ filename: "recording.wav", recordedDate: "2026-04-22" }),
    );
    expect(result).toEqual({ date: "2026-04-22", time: null });
  });
});

describe("exportSiteSoundscapes", () => {
  it("writes a playable AAC clip and labels it with site date and time", async () => {
    await withTempDir(async (dir) => {
      const source = await toneWav(dir);
      const result = await exportSiteSoundscapes({
        siteCode: "REF-007",
        candidates: [cand({ acousticComplexityIndex: 340 })],
        outDir: dir,
        publicPrefix: "sites/REF-007",
        fetchAudio: async () => source,
      });

      expect(result.soundscapes).toHaveLength(1);
      expect(result.soundscapes[0]).toMatchObject({
        file: "sites/REF-007/soundscape-dawn.m4a",
        recordedAt: "2026-04-22",
        recordedTime: "05:25",
        dielPeriod: "dawn",
        durationSeconds: CLIP_SECONDS,
      });

      const stat = await fs.stat(path.join(dir, "soundscape-dawn.m4a"));
      expect(stat.size).toBeGreaterThan(1000);
    });
  });

  it("writes one clip per period, in day order, each from its own recording", async () => {
    await withTempDir(async (dir) => {
      const source = await toneWav(dir, 5);
      const fetched: string[] = [];
      const candidates = SOUNDSCAPE_DIEL_PERIODS.map((p) =>
        cand({ dielPeriod: p, driveFileId: `drive-${p}` }),
      );

      // Shuffled in, to prove the output order comes from the period list and
      // not from the order candidates happened to arrive.
      const result = await exportSiteSoundscapes({
        siteCode: "REF-007",
        candidates: [...candidates].reverse(),
        outDir: dir,
        publicPrefix: "sites/REF-007",
        fetchAudio: async (id) => {
          fetched.push(id);
          return source;
        },
      });

      expect(result.soundscapes.map((s) => s.dielPeriod)).toEqual([
        "dawn", "midday", "dusk", "night",
      ]);
      expect(result.soundscapes.map((s) => s.file)).toEqual([
        "sites/REF-007/soundscape-dawn.m4a",
        "sites/REF-007/soundscape-midday.m4a",
        "sites/REF-007/soundscape-dusk.m4a",
        "sites/REF-007/soundscape-night.m4a",
      ]);
      expect(fetched).toEqual(["drive-dawn", "drive-midday", "drive-dusk", "drive-night"]);
    });
  });

  it("keeps the periods that worked when one of them fails", async () => {
    await withTempDir(async (dir) => {
      const source = await toneWav(dir, 5);
      const result = await exportSiteSoundscapes({
        siteCode: "REF-011",
        candidates: SOUNDSCAPE_DIEL_PERIODS.map((p) =>
          cand({ dielPeriod: p, driveFileId: `drive-${p}` }),
        ),
        outDir: dir,
        publicPrefix: "p",
        fetchAudio: async (id) => {
          if (id === "drive-dusk") throw new Error("drive 500");
          return source;
        },
      });

      // Losing the dusk clip must not cost the reader the dawn chorus.
      expect(result.soundscapes.map((s) => s.dielPeriod)).toEqual([
        "dawn", "midday", "night",
      ]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("dusk");
      // No half-written file left where the verifier would find one.
      expect(await fs.readdir(dir)).not.toContain("soundscape-dusk.m4a");
    });
  });

  it("only exports the periods a site actually recorded", async () => {
    await withTempDir(async (dir) => {
      const source = await toneWav(dir, 5);
      const result = await exportSiteSoundscapes({
        siteCode: "REF-007",
        candidates: [cand({ dielPeriod: "night" })],
        outDir: dir,
        publicPrefix: "p",
        fetchAudio: async () => source,
      });

      expect(result.soundscapes.map((s) => s.dielPeriod)).toEqual(["night"]);
    });
  });

  it("produces AAC audio, not a copy of the source", async () => {
    await withTempDir(async (dir) => {
      const source = await toneWav(dir);
      await exportSiteSoundscapes({
        siteCode: "REF-007",
        candidates: [cand()],
        outDir: dir,
        publicPrefix: "p",
        fetchAudio: async () => source,
      });

      const { stdout } = await run("ffprobe", [
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,channels",
        "-of", "default=nw=1", path.join(dir, "soundscape-dawn.m4a"),
      ]);
      expect(stdout).toContain("codec_name=aac");
      expect(stdout).toContain("channels=1");
    });
  });

  it("cuts to the clip length rather than shipping the whole recording", async () => {
    await withTempDir(async (dir) => {
      const source = await toneWav(dir, 90);
      await exportSiteSoundscapes({
        siteCode: "REF-007",
        candidates: [cand()],
        outDir: dir,
        publicPrefix: "p",
        fetchAudio: async () => source,
      });

      const { stdout } = await run("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", path.join(dir, "soundscape-dawn.m4a"),
      ]);
      expect(Number(stdout.trim())).toBeLessThan(CLIP_SECONDS + 1);
      expect(Number(stdout.trim())).toBeGreaterThan(CLIP_SECONDS - 2);
    });
  });

  it("emits no species field anywhere in the records", async () => {
    await withTempDir(async (dir) => {
      const source = await toneWav(dir, 5);
      const result = await exportSiteSoundscapes({
        siteCode: "REF-007",
        candidates: SOUNDSCAPE_DIEL_PERIODS.map((p) => cand({ dielPeriod: p })),
        outDir: dir,
        publicPrefix: "p",
        fetchAudio: async () => source,
      });

      for (const clip of result.soundscapes) {
        expect(Object.keys(clip)).not.toContain("species");
      }
      expect(JSON.stringify(result.soundscapes).toLowerCase()).not.toContain("species");
    });
  });

  it("ships no clips and fetches nothing when the site has no audio", async () => {
    await withTempDir(async (dir) => {
      const fetchAudio = vi.fn();
      const result = await exportSiteSoundscapes({
        siteCode: "SEC-002",
        candidates: [],
        outDir: dir,
        publicPrefix: "p",
        fetchAudio,
      });

      expect(result.soundscapes).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(fetchAudio).not.toHaveBeenCalled();
    });
  });

  it("warns and continues when the download fails", async () => {
    await withTempDir(async (dir) => {
      const result = await exportSiteSoundscapes({
        siteCode: "REF-011",
        candidates: [cand()],
        outDir: dir,
        publicPrefix: "p",
        fetchAudio: async () => {
          throw new Error("drive 500");
        },
      });

      expect(result.soundscapes).toEqual([]);
      expect(result.warnings[0]).toContain("REF-011");
      expect(result.warnings[0]).toContain("drive 500");
    });
  });

  it("warns rather than throwing when ffmpeg cannot decode the source", async () => {
    await withTempDir(async (dir) => {
      const result = await exportSiteSoundscapes({
        siteCode: "REF-011",
        candidates: [cand()],
        outDir: dir,
        publicPrefix: "p",
        fetchAudio: async () => Buffer.from("this is not audio"),
      });

      expect(result.soundscapes).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });
  });

  it("leaves no downloaded source file behind in the bundle", async () => {
    await withTempDir(async (dir) => {
      const source = await toneWav(dir, 5);
      await exportSiteSoundscapes({
        siteCode: "REF-007",
        candidates: SOUNDSCAPE_DIEL_PERIODS.map((p) => cand({ dielPeriod: p })),
        outDir: dir,
        publicPrefix: "p",
        fetchAudio: async () => source,
      });

      // A whole recording left in the tree would be committed to a public repo.
      expect((await fs.readdir(dir)).sort()).toEqual([
        "soundscape-dawn.m4a",
        "soundscape-dusk.m4a",
        "soundscape-midday.m4a",
        "soundscape-night.m4a",
      ]);
    });
  });
});
