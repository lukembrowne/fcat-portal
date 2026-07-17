/**
 * `/ocupacion`-facing view of the audio recording-schedule subsampling.
 *
 * The raw `AudioSubsampleSummary` from `fetchOccupancyInputs` spans EVERY
 * deployment with audio (including excluded / unverified / other-project ones
 * the window query pulls). This module scopes it to the modeled site pool and
 * flags the degenerate case where normalization silently did not apply. Pure so
 * it is unit-testable without the server action.
 */
import type { AudioSubsampleSummary } from "./audio-subsample";
import type { OccupancySite } from "./detection-history";

export interface AudioSubsampleDeploymentRow {
  deploymentId: number;
  siteName: string;
  nativeCadenceSeconds: number | null;
  filesTotal: number;
  filesKept: number;
  filesDropped: number;
  filesUnparsed: number;
  /**
   * Dense cadence implied (≈5-min) but ~0 drops, or a high unparsed fraction —
   * either means the subsampling did not normalize this deployment and its
   * survey effort is NOT comparable to its peers. Surfaced as a warning.
   */
  degenerate: boolean;
}

export interface AudioSubsampleReport {
  bucketMinutes: number;
  /** Pool-scoped totals (recomputed over the modeled deployments only). */
  filesTotal: number;
  filesKept: number;
  filesDropped: number;
  filesUnparsed: number;
  deployments: AudioSubsampleDeploymentRow[];
}

const DENSE_CADENCE_MAX_SECONDS = 330; // ≈ 5-min schedule, tolerating jitter
const HIGH_UNPARSED_FRACTION = 0.5;

/** True when subsampling silently did not normalize this deployment. */
export function isDegenerateSubsample(row: {
  nativeCadenceSeconds: number | null;
  filesTotal: number;
  filesDropped: number;
  filesUnparsed: number;
}): boolean {
  const denseButNoDrops =
    row.nativeCadenceSeconds != null &&
    row.nativeCadenceSeconds <= DENSE_CADENCE_MAX_SECONDS &&
    row.filesDropped === 0;
  const mostlyUnparsed =
    row.filesTotal > 0 && row.filesUnparsed / row.filesTotal >= HIGH_UNPARSED_FRACTION;
  return denseButNoDrops || mostlyUnparsed;
}

/** Human cadence label (Spanish) from the modal same-day inter-file gap. */
export function formatCadenceLabel(nativeCadenceSeconds: number | null): string {
  if (nativeCadenceSeconds == null) return "sin datos";
  if (nativeCadenceSeconds >= 270 && nativeCadenceSeconds <= 330) return "5 min";
  if (nativeCadenceSeconds >= 540 && nativeCadenceSeconds <= 660) return "10 min";
  return `~${Math.round(nativeCadenceSeconds / 60)} min`;
}

/**
 * Build the pool-scoped subsample report, or null when the stream carried no
 * summary (camera stream, or no audio files). Deployments are ordered by
 * files dropped (most-affected first), stable-tiebroken by deployment id.
 */
export function buildAudioSubsampleReport(
  summary: AudioSubsampleSummary | undefined,
  sites: OccupancySite[],
): AudioSubsampleReport | null {
  if (!summary) return null;
  const nameBySiteId = new Map(sites.map((s) => [s.siteId, s.siteName]));

  const deployments: AudioSubsampleDeploymentRow[] = [];
  let filesTotal = 0;
  let filesKept = 0;
  let filesDropped = 0;
  let filesUnparsed = 0;

  for (const dep of summary.byDeployment.values()) {
    const siteId = String(dep.deploymentId);
    const siteName = nameBySiteId.get(siteId);
    if (siteName === undefined) continue; // pool-scope: skip non-modeled deployments

    filesTotal += dep.filesTotal;
    filesKept += dep.filesKept;
    filesDropped += dep.filesDropped;
    filesUnparsed += dep.filesUnparsed;

    deployments.push({
      deploymentId: dep.deploymentId,
      siteName,
      nativeCadenceSeconds: dep.nativeCadenceSeconds,
      filesTotal: dep.filesTotal,
      filesKept: dep.filesKept,
      filesDropped: dep.filesDropped,
      filesUnparsed: dep.filesUnparsed,
      degenerate: isDegenerateSubsample(dep),
    });
  }

  deployments.sort(
    (a, b) => b.filesDropped - a.filesDropped || a.deploymentId - b.deploymentId,
  );

  return {
    bucketMinutes: summary.bucketMinutes,
    filesTotal,
    filesKept,
    filesDropped,
    filesUnparsed,
    deployments,
  };
}
