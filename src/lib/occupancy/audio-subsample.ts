/**
 * Canonical audio recording subsampling for comparable occupancy survey effort.
 *
 * BioChoco recorders ran two duty cycles: an old 1-min-every-5-min schedule
 * (~12 files/hr) and a newer 10-min cadence (~6 files/hr), and both coexist
 * across the same months (recorders are reconfigured in the field when visited,
 * not on a single date). A denser schedule means more listening time per
 * occasion, which inflates per-occasion detection probability and can bias
 * occupancy for quiet/rare species.
 *
 * This module computes a canonical "kept" recording set that equalizes effort:
 * exactly the FIRST (earliest) file in each fixed 10-minute wall-clock bucket
 * per deployment per UTC calendar day. The rule is self-normalizing — it caps
 * every deployment at <=1 recording per 10-min block regardless of its native
 * cadence or clock phase, so a 10-min deployment is essentially unchanged, a
 * 5-min deployment is halved, and a deployment that switches cadence
 * mid-window normalizes throughout, with NO per-deployment cadence
 * classification and NO date cutoff. Pure over already-fetched rows so it is
 * unit-testable; the DB fetch + occupancy wiring live in the caller
 * (`fetchOccupancyInputs`). See
 * `docs/plans/2026-07-16-005-feat-occupancy-audio-recording-schedule-subsample-plan.md`.
 */
import { parseRecordingTimestamp } from "@/lib/audio-filename";

export interface AudioFileRow {
  id: number;
  deployment_id: number;
  filename: string | null;
}

export interface DeploymentSubsampleSummary {
  deploymentId: number;
  /**
   * Modal same-day gap (seconds) between consecutive files — REPORTED for
   * transparency (5-min schedule ≈ 300, 10-min ≈ 600), never used to decide
   * what to keep. Null when the deployment has no day with >=2 parseable files.
   */
  nativeCadenceSeconds: number | null;
  filesTotal: number;
  filesKept: number;
  filesDropped: number;
  /**
   * Files whose timestamp could not be parsed — kept by default (never
   * subsampled) so a filename-format change can never silently drop data. A
   * high `filesUnparsed` fraction on a dense-cadence deployment is the
   * degenerate case where normalization silently did not apply.
   */
  filesUnparsed: number;
}

export interface AudioSubsampleSummary {
  /** Effective bucket width used (minutes), after env/opts resolution + floor. */
  bucketMinutes: number;
  filesTotal: number;
  filesKept: number;
  filesDropped: number;
  filesUnparsed: number;
  byDeployment: Map<number, DeploymentSubsampleSummary>;
}

export interface SelectCanonicalOptions {
  /** Bucket width in minutes; defaults to env or 10. Set to 1 to keep all files. */
  bucketMinutes?: number;
}

const DEFAULT_BUCKET_MINUTES = 10;

function resolveBucketMinutes(opts: SelectCanonicalOptions): number {
  const raw = opts.bucketMinutes ?? Number(process.env.OCCUPANCY_AUDIO_SUBSAMPLE_BUCKET_MINUTES);
  const usable = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUCKET_MINUTES;
  return Math.max(1, Math.floor(usable));
}

/** Seconds-of-day from a `HH:MM:SS` time string, or null if malformed. */
function secondsOfDay(time: string): number | null {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Most frequent value in a list, ties broken by the smallest value. Null if empty. */
function modalValue(values: number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && (best === null || value < best))) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

interface ParsedFile {
  id: number;
  deploymentId: number;
  date: string;
  secs: number;
}

/**
 * Select the canonical kept-file set: the earliest file in each
 * `(deployment_id, UTC calendar day, floor(secondsOfDay / bucketSeconds))`
 * bucket. Unparseable filenames are always kept. Returns the kept `audio_files`
 * ids plus a per-deployment + overall subsample summary.
 */
export function selectCanonicalAudioFiles(
  files: AudioFileRow[],
  opts: SelectCanonicalOptions = {},
): { keptIds: Set<number>; summary: AudioSubsampleSummary } {
  const bucketMinutes = resolveBucketMinutes(opts);
  const bucketSeconds = bucketMinutes * 60;

  const keptIds = new Set<number>();
  const byDeployment = new Map<number, DeploymentSubsampleSummary>();

  const summaryFor = (deploymentId: number): DeploymentSubsampleSummary => {
    let s = byDeployment.get(deploymentId);
    if (!s) {
      s = {
        deploymentId,
        nativeCadenceSeconds: null,
        filesTotal: 0,
        filesKept: 0,
        filesDropped: 0,
        filesUnparsed: 0,
      };
      byDeployment.set(deploymentId, s);
    }
    return s;
  };

  // Best (earliest) parseable file per bucket, and the per-deployment sequences
  // used to report native cadence.
  const bestByBucket = new Map<string, ParsedFile>();
  const parsed: ParsedFile[] = [];

  for (const f of files) {
    const dep = summaryFor(f.deployment_id);
    dep.filesTotal++;

    const ts = f.filename ? parseRecordingTimestamp(f.filename) : null;
    const secs = ts ? secondsOfDay(ts.time) : null;
    if (!ts || secs === null) {
      // Unparseable → keep by default, never subsampled.
      dep.filesUnparsed++;
      keptIds.add(f.id);
      continue;
    }

    const pf: ParsedFile = { id: f.id, deploymentId: f.deployment_id, date: ts.date, secs };
    parsed.push(pf);
    const bucket = Math.floor(secs / bucketSeconds);
    const key = `${f.deployment_id}|${ts.date}|${bucket}`;
    const cur = bestByBucket.get(key);
    if (!cur || pf.secs < cur.secs || (pf.secs === cur.secs && pf.id < cur.id)) {
      bestByBucket.set(key, pf);
    }
  }

  for (const pf of bestByBucket.values()) keptIds.add(pf.id);

  // Kept/dropped counts per deployment (parseable files only; unparsed already
  // counted above and always kept).
  const parseableByDeployment = new Map<number, number>();
  for (const pf of parsed) {
    parseableByDeployment.set(pf.deploymentId, (parseableByDeployment.get(pf.deploymentId) ?? 0) + 1);
  }
  const keptParseableByDeployment = new Map<number, number>();
  for (const pf of bestByBucket.values()) {
    keptParseableByDeployment.set(
      pf.deploymentId,
      (keptParseableByDeployment.get(pf.deploymentId) ?? 0) + 1,
    );
  }

  // Native cadence: modal same-day consecutive-file gap per deployment.
  const dayGaps = new Map<number, number[]>(); // deploymentId → gaps
  const byDepDay = new Map<string, number[]>(); // `${dep}|${date}` → secs[]
  for (const pf of parsed) {
    const key = `${pf.deploymentId}|${pf.date}`;
    const arr = byDepDay.get(key);
    if (arr) arr.push(pf.secs);
    else byDepDay.set(key, [pf.secs]);
  }
  for (const [key, secsList] of byDepDay) {
    const depId = Number(key.slice(0, key.indexOf("|")));
    secsList.sort((a, b) => a - b);
    const gaps = dayGaps.get(depId) ?? [];
    for (let i = 1; i < secsList.length; i++) gaps.push(secsList[i] - secsList[i - 1]);
    dayGaps.set(depId, gaps);
  }

  for (const dep of byDeployment.values()) {
    const keptUnparsed = dep.filesUnparsed; // all unparsed are kept
    const keptParseable = keptParseableByDeployment.get(dep.deploymentId) ?? 0;
    dep.filesKept = keptParseable + keptUnparsed;
    dep.filesDropped = (parseableByDeployment.get(dep.deploymentId) ?? 0) - keptParseable;
    dep.nativeCadenceSeconds = modalValue(dayGaps.get(dep.deploymentId) ?? []);
  }

  const summary: AudioSubsampleSummary = {
    bucketMinutes,
    filesTotal: files.length,
    filesKept: keptIds.size,
    filesDropped: files.length - keptIds.size,
    filesUnparsed: [...byDeployment.values()].reduce((n, d) => n + d.filesUnparsed, 0),
    byDeployment,
  };

  return { keptIds, summary };
}
