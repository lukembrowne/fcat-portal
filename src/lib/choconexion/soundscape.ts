/**
 * Soundscape clip selection and encoding for the Choconexión bundle.
 *
 * One clip per diel period per site, presented as a recording from that site at
 * a stated date and time — atmosphere, not a species claim. This is the whole
 * reason the audio side of the bundle exists in this shape: the 377,429 BirdNET
 * identifications at these sites have zero human review and no species carries
 * an applied confidence threshold, so any "species heard here" list would be a
 * model's guess published as a result. A clip makes the acoustic monitoring
 * audible without asserting anything about what is singing.
 *
 * Nothing in this module emits a species field. That is not an oversight.
 *
 * Selection is reproducible: within each period, the recording with the highest
 * acoustic complexity at that site, with the audio file id breaking ties.
 * Re-running the export on unchanged data picks the same recordings.
 */

import "server-only";

import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { log } from "@/lib/log";
import { parseRecordingTimestamp } from "@/lib/audio-filename";

import type { SiteSoundscape } from "./types";

/**
 * The diel periods a site's clips are drawn from, in day order — which is the
 * order they reach the viewer's chips.
 *
 * These are exactly the named windows `src/lib/acoustic-indices.ts` assigns
 * (dawn 05–07, midday 11–13, dusk 17–19, night 22–04); `other` is deliberately
 * absent because "some hour in between" is not a time of day anyone asks to
 * hear. All fourteen sites with processed audio have candidates in all four.
 *
 * Fixing the periods is what makes the clips comparable: every site's dawn clip
 * is drawn the same way, so two plots can be listened to against each other.
 */
export const SOUNDSCAPE_DIEL_PERIODS = ["dawn", "midday", "dusk", "night"] as const;

export type SoundscapePeriod = (typeof SOUNDSCAPE_DIEL_PERIODS)[number];

/**
 * Clip length. Recordings at these sites are one minute, so this takes half of
 * the chosen recording.
 *
 * It was the whole minute while a site shipped one clip. Four periods at a full
 * minute each would put ~41 MB of audio in a repo that commits its bundle and
 * rewrites every byte of it on each refresh; halving the cut holds the audio
 * near 20 MB while doubling how much there is to listen to per site. Bitrate is
 * untouched, so the clips sound exactly as they did.
 *
 * This constant and the bitrate below are the levers if the committed bundle
 * grows too large for comfort in the Choconexión repo: at 96 kbps mono, thirty
 * seconds is roughly 370 KB, and there are up to four per site.
 */
export const CLIP_SECONDS = 30;

/** Mono at 96 kbps. Atmosphere, not analysis — the source is already lossy-safe. */
const AUDIO_BITRATE = "96k";

const FFMPEG_TIMEOUT_MS = 120_000;

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

export interface SoundscapeCandidate {
  audioFileId: number;
  driveFileId: string | null;
  filename: string;
  dielPeriod: string;
  acousticComplexityIndex: number | null;
  /** `YYYY-MM-DD` as computed when the indices were written. */
  recordedDate: string | null;
}

/**
 * The clip to use for one site at one period, or null when the site has no
 * processed audio in it. P08 has no audio at all and P12's is unprocessed; both
 * ship without clips rather than with placeholders.
 */
export function selectSoundscape(
  candidates: SoundscapeCandidate[],
  period: SoundscapePeriod,
): SoundscapeCandidate | null {
  const eligible = candidates.filter(
    (c) =>
      c.dielPeriod === period &&
      c.driveFileId &&
      c.acousticComplexityIndex != null &&
      Number.isFinite(c.acousticComplexityIndex),
  );
  if (eligible.length === 0) return null;

  return eligible.reduce((best, current) => {
    const delta = current.acousticComplexityIndex! - best.acousticComplexityIndex!;
    if (delta > 0) return current;
    if (delta < 0) return best;
    // Deterministic tiebreak, so the same input always yields the same clip.
    return current.audioFileId < best.audioFileId ? current : best;
  });
}

/**
 * Recording date and local time, read from the filename.
 *
 * Not from `audio_files.modified_at`: for the roughly fifteen deployments
 * uploaded through the Drive web UI that column is the upload date, not the
 * recording time, and a clip labelled with its upload date is simply wrong.
 */
export function soundscapeTimestamp(
  candidate: SoundscapeCandidate,
): { date: string | null; time: string | null } {
  const parsed = parseRecordingTimestamp(candidate.filename);
  if (parsed) return { date: parsed.date, time: parsed.time.slice(0, 5) };
  return { date: candidate.recordedDate, time: null };
}

export type AudioFetcher = (driveFileId: string) => Promise<Buffer>;

export interface ExportSoundscapeOptions {
  siteCode: string;
  candidates: SoundscapeCandidate[];
  /** Absolute directory for this site's assets. */
  outDir: string;
  /** Path prefix recorded in the bundle, e.g. `sites/REF-007`. */
  publicPrefix: string;
  fetchAudio: AudioFetcher;
}

export interface ExportSoundscapeResult {
  soundscapes: SiteSoundscape[];
  warnings: string[];
}

/**
 * Fetch and cut one mono AAC clip per diel period that has usable audio here.
 *
 * AAC because compressed audio at these sites is FLAC, which mobile Safari
 * cannot decode at all — a clip nobody can play on a phone is not a clip.
 *
 * Periods are isolated from one another: a period whose recording will not
 * download or will not decode is warned about and left out, and the site still
 * ships the periods that worked. Losing the dusk clip must not cost a reader
 * the dawn chorus.
 *
 * Serial rather than parallel — the caller already runs four sites at a time,
 * and four concurrent whole-recording downloads per site would be sixteen in
 * flight against Drive.
 */
export async function exportSiteSoundscapes({
  siteCode,
  candidates,
  outDir,
  publicPrefix,
  fetchAudio,
}: ExportSoundscapeOptions): Promise<ExportSoundscapeResult> {
  const soundscapes: SiteSoundscape[] = [];
  const warnings: string[] = [];

  for (const period of SOUNDSCAPE_DIEL_PERIODS) {
    const chosen = selectSoundscape(candidates, period);
    if (!chosen) continue;

    await fs.mkdir(outDir, { recursive: true });
    const name = `soundscape-${period}.m4a`;
    const outPath = path.join(outDir, name);
    const sourcePath = path.join(outDir, `.soundscape-source-${chosen.audioFileId}`);

    try {
      const source = await fetchAudio(chosen.driveFileId!);
      await fs.writeFile(sourcePath, source);
      await runFfmpegCut(sourcePath, outPath);

      const { date, time } = soundscapeTimestamp(chosen);
      soundscapes.push({
        file: `${publicPrefix}/${name}`,
        recordedAt: date,
        recordedTime: time,
        dielPeriod: period,
        durationSeconds: CLIP_SECONDS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { siteCode, period, audioFileId: chosen.audioFileId, err: message },
        "[choconexion] soundscape export failed, skipping",
      );
      warnings.push(
        `${siteCode}: no se pudo exportar el clip de paisaje sonoro de ${period} (${message}).`,
      );
      // A half-written clip would pass the verifier's existence check.
      await fs.unlink(outPath).catch(() => {});
    } finally {
      // The source is a whole recording; never leave one behind in the bundle.
      await fs.unlink(sourcePath).catch(() => {});
    }
  }

  return { soundscapes, warnings };
}

/**
 * Cut the first `CLIP_SECONDS` into mono AAC.
 *
 * Settings carried from `src/lib/birdnet-validation/clip-cache.ts`, where they
 * are already proven against these recordings: `-ss` before `-i` so the seek
 * happens on input, and `+faststart` so playback can begin before the whole
 * file arrives.
 */
function runFfmpegCut(srcPath: string, outPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-ss",
      "0",
      "-t",
      String(CLIP_SECONDS),
      "-i",
      srcPath,
      "-c:a",
      "aac",
      "-b:a",
      AUDIO_BITRATE,
      "-ac",
      "1",
      "-movflags",
      "+faststart",
      outPath,
    ];

    const proc = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: string[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
      reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    proc.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`No se pudo ejecutar ffmpeg: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg salió con código ${code}: ${stderr.join("").slice(-400)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

interface RawSoundscapeRow {
  deploymentId: number;
  audioFileId: number;
  driveFileId: string | null;
  filename: string;
  dielPeriod: string;
  acousticComplexityIndex: number | null;
  recordedDate: string | null;
}

/**
 * Candidates for the given deployments in every exported period, keyed by
 * deployment id.
 *
 * Scoped to the named periods in SQL: these sites hold roughly 66,000 index rows
 * between them and more than half of those are `other`, which is never eligible.
 */
export async function loadSoundscapeCandidates(
  deploymentIds: number[],
): Promise<Map<number, SoundscapeCandidate[]>> {
  const byDeployment = new Map<number, SoundscapeCandidate[]>();
  if (deploymentIds.length === 0) return byDeployment;

  const rows = await db.all<RawSoundscapeRow>(sql`
    SELECT
      af.deployment_id                AS deploymentId,
      af.id                           AS audioFileId,
      af.drive_file_id                AS driveFileId,
      af.filename                     AS filename,
      ai.diel_period                  AS dielPeriod,
      ai.acoustic_complexity_index    AS acousticComplexityIndex,
      ai.recorded_date                AS recordedDate
    FROM acoustic_indices ai
    JOIN audio_files af ON af.id = ai.audio_file_id
    WHERE af.deployment_id IN (${sql.join(
      deploymentIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND ai.diel_period IN (${sql.join(
        SOUNDSCAPE_DIEL_PERIODS.map((p) => sql`${p}`),
        sql`, `,
      )})
      AND af.drive_file_id IS NOT NULL
      AND ai.acoustic_complexity_index IS NOT NULL
    ORDER BY af.deployment_id, ai.diel_period, ai.acoustic_complexity_index DESC, af.id ASC`);

  for (const row of rows) {
    const list = byDeployment.get(row.deploymentId);
    if (list) list.push(row);
    else byDeployment.set(row.deploymentId, [row]);
  }

  return byDeployment;
}
