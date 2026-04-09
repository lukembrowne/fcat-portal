/**
 * Deployment-window QC check used by camera-trap and audio modules.
 *
 * Compares observed file timestamps (first/last) against the ODK-reported
 * install/retrieve window. Mirrors the iButton coverage check in
 * `src/app/biochoco/ibutton/coverage.ts`, but is metric-agnostic — there is no
 * fixed cadence to compare against, so we report:
 *   - whether any files fall outside the window (cheap, list-view friendly)
 *   - the precise outlier count (only when the caller computes it; null on
 *     list views to keep aggregate queries cheap)
 *
 * All timestamps are naive "YYYY-MM-DD HH:mm:ss" strings in Ecuador local
 * time (UTC-5), matching the convention used by iButton readings, ODK
 * datetimes, and image EXIF timestamps in this codebase. String comparison
 * is well-defined for that format.
 */

export interface WindowQcInputs {
  /** ODK install datetime, "YYYY-MM-DD HH:mm:ss" — null if unavailable */
  odkDeployAt: string | null;
  /** ODK retrieve datetime, "YYYY-MM-DD HH:mm:ss" — null if unavailable */
  odkRetrieveAt: string | null;
  /** Earliest file timestamp on this deployment, "YYYY-MM-DD HH:mm:ss" */
  firstFileAt: string | null;
  /** Latest file timestamp on this deployment, "YYYY-MM-DD HH:mm:ss" */
  lastFileAt: string | null;
  /** Total files on the deployment */
  totalFiles: number;
  /** Files whose timestamp falls strictly outside [deploy, retrieve].
   *  Pass `null` from list views to skip the per-deployment outlier scan. */
  outsideCount: number | null;
}

export interface WindowQcResult extends WindowQcInputs {
  /** True iff both ODK deploy + retrieve datetimes are present */
  hasWindow: boolean;
  /** True iff first<deploy or last>retrieve. Always false when !hasWindow. */
  hasOutOfWindow: boolean;
  /** (totalFiles - outsideCount) / totalFiles * 100. Null when outsideCount
   *  is null, totalFiles is 0, or window is missing. */
  insidePct: number | null;
}

export function computeWindowQc(input: WindowQcInputs): WindowQcResult {
  const {
    odkDeployAt,
    odkRetrieveAt,
    firstFileAt,
    lastFileAt,
    totalFiles,
    outsideCount,
  } = input;

  const hasWindow = Boolean(odkDeployAt && odkRetrieveAt);

  let hasOutOfWindow = false;
  if (hasWindow && totalFiles > 0) {
    if (firstFileAt && firstFileAt < odkDeployAt!) hasOutOfWindow = true;
    if (lastFileAt && lastFileAt > odkRetrieveAt!) hasOutOfWindow = true;
  }

  let insidePct: number | null = null;
  if (hasWindow && outsideCount !== null && totalFiles > 0) {
    const inside = Math.max(0, totalFiles - outsideCount);
    insidePct = Math.min(100, Math.round((inside / totalFiles) * 100));
  }

  return {
    odkDeployAt,
    odkRetrieveAt,
    firstFileAt,
    lastFileAt,
    totalFiles,
    outsideCount,
    hasWindow,
    hasOutOfWindow,
    insidePct,
  };
}
