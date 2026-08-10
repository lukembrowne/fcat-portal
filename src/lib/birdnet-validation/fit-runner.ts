/**
 * TS bridge to `scripts/birdnet-threshold-runner.R`.
 *
 * ONE warm R worker in loop mode, not a pool. The occupancy pool exists because
 * `unmarked::occu` costs seconds per model across ~685 models; a two-parameter
 * logistic on ~200 rows costs microseconds, so ~200 species fit in well under a
 * second once R is warm. The ~1.3s interpreter startup is the only real cost and
 * a single worker pays it once.
 *
 * ALWAYS resolves, never rejects — callers get a discriminated result per
 * campaign. A worker crash or a per-campaign timeout fails only the campaigns
 * that were in flight.
 */

import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

import { log } from "@/lib/log";
import { resolveRscript } from "@/lib/r-runtime";
import {
  MIN_REVIEWS_FOR_FIT,
  TARGET_PROBABILITIES,
  type UnusableReasonCode,
} from "./types";

export const THRESHOLD_R_SCRIPT = path.join(
  process.cwd(),
  "scripts",
  "birdnet-threshold-runner.R"
);

const STARTUP_TIMEOUT_MS = 60_000;
const PER_FIT_TIMEOUT_MS = 30_000;

export interface FitObservation {
  conf: number;
  /** 1 = BirdNET's prediction was correct, 0 = incorrect. */
  outcome: 0 | 1;
}

export interface FitRequest {
  campaignId: number;
  species: string;
  observations: FitObservation[];
}

export interface ThresholdEstimate {
  conf: number;
  logit: number;
  se: number | null;
  lower?: number;
  upper?: number;
}

export type FitResult =
  | {
      campaignId: number;
      usable: true;
      intercept: number;
      slope: number;
      converged: boolean;
      nReviewed: number;
      nCorrect: number;
      thresholds: Record<string, ThresholdEstimate>;
    }
  | {
      campaignId: number;
      usable: false;
      reason: UnusableReasonCode;
      nReviewed: number;
      nCorrect: number;
    };

interface RReadyLine {
  type: "ready";
  R: string;
}

interface RResultLine {
  type: "result";
  id: number;
  usable: boolean;
  reason?: string;
  intercept?: number;
  slope?: number;
  converged?: boolean;
  nReviewed: number;
  nCorrect: number;
  thresholds?: Record<string, ThresholdEstimate>;
}

interface RErrorLine {
  type: "error";
  id: number | null;
  message: string;
}

type RLine = RReadyLine | RResultLine | RErrorLine;

const KNOWN_REASONS = new Set<UnusableReasonCode>([
  "insufficient_sample",
  "complete_separation",
  "non_monotonic",
  "threshold_out_of_range",
  "fit_failed",
]);

function toReason(raw: string | undefined): UnusableReasonCode {
  return raw && KNOWN_REASONS.has(raw as UnusableReasonCode)
    ? (raw as UnusableReasonCode)
    : "fit_failed";
}

function failed(
  campaignId: number,
  reason: UnusableReasonCode,
  nReviewed = 0,
  nCorrect = 0
): FitResult {
  return { campaignId, usable: false, reason, nReviewed, nCorrect };
}

/**
 * Fit every request in one warm R process.
 *
 * Requests below the minimum review count are short-circuited in TypeScript
 * rather than sent to R — the answer does not depend on the model and skipping
 * the round-trip keeps the common "species has barely been reviewed" case cheap.
 */
export async function fitThresholds(requests: FitRequest[]): Promise<FitResult[]> {
  const results = new Map<number, FitResult>();

  const sendable: FitRequest[] = [];
  for (const req of requests) {
    if (req.observations.length < MIN_REVIEWS_FOR_FIT) {
      const nCorrect = req.observations.filter((o) => o.outcome === 1).length;
      results.set(
        req.campaignId,
        failed(req.campaignId, "insufficient_sample", req.observations.length, nCorrect)
      );
    } else {
      sendable.push(req);
    }
  }

  if (sendable.length === 0) {
    return requests.map(
      (r) => results.get(r.campaignId) ?? failed(r.campaignId, "fit_failed")
    );
  }

  let child: ChildProcess | null = null;
  try {
    child = spawn(resolveRscript(), [THRESHOLD_R_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    log.error({ err }, "[birdnet-threshold] failed to spawn Rscript");
    return requests.map(
      (r) => results.get(r.campaignId) ?? failed(r.campaignId, "fit_failed")
    );
  }

  const proc = child;
  let stderr = "";
  proc.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const rl = createInterface({ input: proc.stdout! });

  await new Promise<void>((resolve) => {
    let settled = false;
    const pending = new Set(sendable.map((r) => r.campaignId));

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      clearTimeout(fitTimer);
      rl.close();
      // The worker exits on stdin EOF; kill only if it is still alive.
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      resolve();
    };

    const startupTimer = setTimeout(() => {
      log.error(
        { stderr },
        "[birdnet-threshold] R worker never became ready; failing all fits"
      );
      finish();
    }, STARTUP_TIMEOUT_MS);

    // One budget covering the whole batch of fits. Each fit is milliseconds; a
    // batch that blows this is wedged, not slow.
    const fitTimer = setTimeout(
      () => {
        log.error(
          { stderr, pending: [...pending] },
          "[birdnet-threshold] R worker timed out"
        );
        finish();
      },
      PER_FIT_TIMEOUT_MS * Math.max(1, sendable.length)
    );

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let parsed: RLine;
      try {
        parsed = JSON.parse(trimmed) as RLine;
      } catch {
        log.warn({ line: trimmed }, "[birdnet-threshold] unparseable line from R");
        return;
      }

      if (parsed.type === "ready") {
        clearTimeout(startupTimer);
        for (const req of sendable) {
          proc.stdin!.write(
            // JSON.stringify keeps full double precision. R's jsonlite defaults
            // to 4 digits, which silently perturbs the fit — always serialise
            // from this side.
            `${JSON.stringify({
              id: req.campaignId,
              species: req.species,
              observations: req.observations,
              probabilities: TARGET_PROBABILITIES,
              minReviews: MIN_REVIEWS_FOR_FIT,
            })}\n`
          );
        }
        proc.stdin!.end();
        return;
      }

      if (parsed.type === "error") {
        log.warn({ message: parsed.message, id: parsed.id }, "[birdnet-threshold] fit error");
        if (parsed.id != null) {
          results.set(parsed.id, failed(parsed.id, "fit_failed"));
          pending.delete(parsed.id);
        }
        if (pending.size === 0) finish();
        return;
      }

      if (parsed.type === "result") {
        const id = parsed.id;
        results.set(
          id,
          parsed.usable
            ? {
                campaignId: id,
                usable: true,
                intercept: parsed.intercept!,
                slope: parsed.slope!,
                converged: Boolean(parsed.converged),
                nReviewed: parsed.nReviewed,
                nCorrect: parsed.nCorrect,
                thresholds: parsed.thresholds ?? {},
              }
            : failed(id, toReason(parsed.reason), parsed.nReviewed, parsed.nCorrect)
        );
        pending.delete(id);
        if (pending.size === 0) finish();
      }
    });

    proc.on("error", (err) => {
      log.error({ err }, "[birdnet-threshold] R worker process error");
      finish();
    });

    proc.on("close", () => {
      finish();
    });
  });

  return requests.map(
    (r) => results.get(r.campaignId) ?? failed(r.campaignId, "fit_failed")
  );
}
