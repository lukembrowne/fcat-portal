import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";
import { log } from "@/lib/log";
import {
  R_SCRIPT,
  resolveRscript,
  type OccupancyRunConfig,
  type OccupancyRunResult,
  type OccupancyResult,
} from "./runner";

/**
 * Persistent pool of warm R worker processes for occupancy model fitting.
 *
 * Each worker runs `scripts/occupancy-runner.R` in its worker-loop mode: it loads
 * `unmarked` ONCE, emits `{type:"ready"}`, then fits one config per stdin line
 * for its whole lifetime. The pool spawns N such workers, dispatches queued fit
 * configs across them (at most one in-flight per worker), and correlates each
 * `{type:"result"|"error", id}` line back to the submitting caller.
 *
 * This replaces the spawn-one-Rscript-per-model design (`runOccupancyModel`),
 * which paid the ~1.3s R+unmarked startup for every one of ~685 models. Warm
 * reuse eliminates that per-model startup; N workers add core-level parallelism.
 *
 * Fault handling mirrors `src/lib/ml-runner.ts`: a per-model timeout or a worker
 * crash fails ONLY that model (as a normal failure `OccupancyRunResult`, never a
 * throw) and respawns a replacement worker so remaining capacity is preserved.
 * JS is single-threaded, so although fits run concurrently in R, every result
 * callback runs serially on the event loop — callers persist without locking.
 */

/** Per-model wall-clock ceiling before the worker is killed + respawned. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** A worker that never emits `ready` within this window is treated as dead. */
const STARTUP_TIMEOUT_MS = 60_000;
/** Flat conservative default (operator direction 2026-07-16): protect co-tenants
 *  on the shared droplet. Override with OCCUPANCY_WORKERS; capped at core count. */
const DEFAULT_POOL_SIZE = 4;

export interface OccupancyPoolOptions {
  /** Worker count. Defaults to resolvePoolSize(). Floored at 1. */
  size?: number;
  /** Per-model timeout (ms). Defaults to 120_000. */
  timeoutMs?: number;
  /**
   * Spawn override for testing — point workers at a stub instead of Rscript.
   * Defaults to the real R runner: `{ command: resolveRscript(), args: [R_SCRIPT] }`.
   */
  spawn?: { command: string; args: string[] };
}

export interface OccupancyPool {
  /** Fit one config on the next free worker; resolves (never rejects) with the result. */
  submit(config: OccupancyRunConfig): Promise<OccupancyRunResult>;
  /** Drain in-flight work best-effort and terminate all workers. Idempotent. */
  shutdown(): Promise<void>;
  /** Current worker count (for tests/diagnostics). */
  readonly size: number;
}

/**
 * Resolve the pool size: OCCUPANCY_WORKERS if set and valid, else 4; floored at
 * 1 and never more than the machine's core count (`availableParallelism()`
 * respects cgroup CPU limits inside containers).
 */
export function resolvePoolSize(): number {
  const cores = Math.max(1, os.availableParallelism());
  const raw = process.env.OCCUPANCY_WORKERS;
  // A numeric value (even a too-low 0) is honored and clamped to [1, cores];
  // only a non-numeric/empty value falls back to the flat default.
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.min(Math.max(1, Math.floor(n)), cores);
  }
  return Math.min(DEFAULT_POOL_SIZE, cores);
}

interface PoolJob {
  id: number;
  config: OccupancyRunConfig;
  resolve: (r: OccupancyRunResult) => void;
}

interface Worker {
  proc: ChildProcess;
  status: "starting" | "ready" | "busy" | "dead";
  currentJob: PoolJob | null;
  timer: ReturnType<typeof setTimeout> | null;
  startupTimer: ReturnType<typeof setTimeout> | null;
  version: { unmarked: string; R: string } | null;
  /** Bounded tail of stderr for crash diagnostics. */
  stderr: string[];
}

const STDERR_TAIL = 10;

export function createOccupancyPool(opts: OccupancyPoolOptions = {}): OccupancyPool {
  const size = Math.max(1, opts.size ?? resolvePoolSize());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnCmd = opts.spawn ?? { command: resolveRscript(), args: [R_SCRIPT] };

  const workers: Worker[] = [];
  const queue: PoolJob[] = [];
  let nextId = 1;
  let shuttingDown = false;
  // Set when the respawn backstop trips (workers can't stay alive, e.g. Rscript
  // missing). Once broken, further submits fail fast instead of queueing behind
  // workers that will never come back.
  let broken = false;
  // Guard against a boot-loop (e.g. Rscript missing): if replacements keep dying,
  // stop respawning and fail the remaining queue instead of spinning forever.
  let respawns = 0;
  const maxRespawns = size * 3 + 3;

  function spawnWorker(): Worker {
    const proc = spawn(spawnCmd.command, spawnCmd.args, { stdio: ["pipe", "pipe", "pipe"], env: workerEnv() });
    const worker: Worker = {
      proc,
      status: "starting",
      currentJob: null,
      timer: null,
      startupTimer: null,
      version: null,
      stderr: [],
    };

    worker.startupTimer = setTimeout(() => {
      if (worker.status === "starting") {
        log.warn("[occupancy-pool] worker failed to become ready — killing");
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }, STARTUP_TIMEOUT_MS);

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let msg: { type?: string; id?: number | null; message?: string; unmarked?: string; R?: string };
      try {
        msg = JSON.parse(t);
      } catch {
        return; // ignore non-JSON noise
      }
      handleMessage(worker, msg);
    });

    const errRl = createInterface({ input: proc.stderr! });
    errRl.on("line", (line) => {
      worker.stderr.push(line);
      if (worker.stderr.length > STDERR_TAIL) worker.stderr.shift();
    });

    proc.on("close", (code, signal) => onWorkerClose(worker, code, signal));
    proc.on("error", (err) => {
      log.error({ err: err.message }, "[occupancy-pool] worker spawn error");
      // 'close' fires after 'error'; onWorkerClose handles fail+respawn.
    });

    return worker;
  }

  function handleMessage(
    worker: Worker,
    msg: { type?: string; id?: number | null; message?: string; unmarked?: string; R?: string },
  ): void {
    if (msg.type === "ready") {
      if (worker.startupTimer) {
        clearTimeout(worker.startupTimer);
        worker.startupTimer = null;
      }
      worker.version = { unmarked: String(msg.unmarked), R: String(msg.R) };
      worker.status = "ready";
      dispatch();
      return;
    }

    if (msg.type === "result" || msg.type === "error") {
      const job = worker.currentJob;
      if (!job) return; // stray/late line after teardown
      clearJobTimer(worker);
      worker.currentJob = null;
      worker.status = "ready";
      if (msg.type === "result") {
        job.resolve({
          success: true,
          version: worker.version ?? { unmarked: "unknown", R: "unknown" },
          result: msg as unknown as OccupancyResult,
        });
      } else {
        job.resolve({ success: false, error: String(msg.message ?? "unknown R error") });
      }
      dispatch();
    }
  }

  function onWorkerClose(worker: Worker, code: number | null, signal: NodeJS.Signals | null): void {
    if (worker.startupTimer) {
      clearTimeout(worker.startupTimer);
      worker.startupTimer = null;
    }
    clearJobTimer(worker);
    worker.status = "dead";

    // Fail whatever this worker had in flight (crash or timeout-kill).
    if (worker.currentJob) {
      const job = worker.currentJob;
      worker.currentJob = null;
      const tail = worker.stderr.length ? `: ${worker.stderr.slice(-3).join(" ")}` : "";
      const how = signal ? `signal ${signal}` : `exit ${code}`;
      job.resolve({
        success: false,
        error: `occupancy worker died mid-fit (${how})${tail}`,
      });
    }

    // Drop the dead worker from the roster.
    const idx = workers.indexOf(worker);
    if (idx !== -1) workers.splice(idx, 1);

    if (shuttingDown) return;

    // Respawn a replacement so the pool keeps its capacity — unless we've hit the
    // boot-loop guard, in which case fail the remaining queue rather than spin.
    if (respawns >= maxRespawns) {
      log.error({ respawns }, "[occupancy-pool] respawn limit hit — failing queued jobs");
      broken = true;
      failQueue("occupancy worker pool is unavailable (repeated worker crashes)");
      return;
    }
    respawns++;
    workers.push(spawnWorker());
    dispatch();
  }

  function clearJobTimer(worker: Worker): void {
    if (worker.timer) {
      clearTimeout(worker.timer);
      worker.timer = null;
    }
  }

  function assign(worker: Worker, job: PoolJob): void {
    worker.currentJob = job;
    worker.status = "busy";
    worker.timer = setTimeout(() => {
      log.warn({ id: job.id }, "[occupancy-pool] model timed out — killing worker");
      // The close handler fails the job and respawns; killing is enough.
      try {
        worker.proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, timeoutMs);
    try {
      worker.proc.stdin!.write(JSON.stringify({ ...job.config, id: job.id }) + "\n");
    } catch (err) {
      // stdin unwritable — treat like a crash for this job.
      clearJobTimer(worker);
      worker.currentJob = null;
      worker.status = "dead";
      job.resolve({
        success: false,
        error: `occupancy worker stdin unwritable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  function dispatch(): void {
    if (shuttingDown) return;
    for (const worker of workers) {
      if (queue.length === 0) break;
      if (worker.status === "ready") {
        assign(worker, queue.shift()!);
      }
    }
  }

  function failQueue(message: string): void {
    while (queue.length > 0) {
      queue.shift()!.resolve({ success: false, error: message });
    }
  }

  // Spin up the initial roster.
  for (let i = 0; i < size; i++) workers.push(spawnWorker());

  return {
    size,
    submit(config: OccupancyRunConfig): Promise<OccupancyRunResult> {
      if (shuttingDown) {
        return Promise.resolve({ success: false, error: "occupancy pool is shutting down" });
      }
      if (broken) {
        return Promise.resolve({
          success: false,
          error: "occupancy worker pool is unavailable (repeated worker crashes)",
        });
      }
      return new Promise<OccupancyRunResult>((resolve) => {
        queue.push({ id: nextId++, config, resolve });
        dispatch();
      });
    },
    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      failQueue("occupancy pool shut down before this model was dispatched");
      const snapshot = [...workers];
      await Promise.all(
        snapshot.map(
          (w) =>
            new Promise<void>((resolve) => {
              if (w.startupTimer) clearTimeout(w.startupTimer);
              clearJobTimer(w);
              if (w.proc.exitCode != null || w.proc.signalCode != null) {
                resolve();
                return;
              }
              w.proc.once("close", () => resolve());
              // Close stdin so the R loop hits EOF and exits cleanly; SIGKILL after
              // a short grace in case a fit is wedged.
              try {
                w.proc.stdin!.end();
              } catch {
                /* ignore */
              }
              const grace = setTimeout(() => {
                try {
                  w.proc.kill("SIGKILL");
                } catch {
                  /* already dead */
                }
              }, 2_000);
              w.proc.once("close", () => clearTimeout(grace));
            }),
        ),
      );
      workers.length = 0;
    },
  };
}

/**
 * Env for a worker: pin BLAS/OMP thread pools to 1. Parallelism comes from the
 * pool (N workers), so letting each unmarked/BLAS fit spawn its own threads would
 * oversubscribe cores. (Opposite of ml-runner, which wants all cores in its ONE
 * process.)
 */
function workerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OMP_NUM_THREADS: "1",
    MKL_NUM_THREADS: "1",
    OPENBLAS_NUM_THREADS: "1",
    NUMEXPR_NUM_THREADS: "1",
  };
}

// Best-effort teardown if the Node process is signalled mid-build. Individual
// pools also shut down in build-run's finally; this is a backstop against orphans.
let activePools: OccupancyPool[] = [];
export function registerPoolForShutdown(pool: OccupancyPool): void {
  activePools.push(pool);
}
function shutdownAllPools(): void {
  const pools = activePools;
  activePools = [];
  for (const p of pools) void p.shutdown();
}
process.on("SIGTERM", shutdownAllPools);
process.on("SIGINT", shutdownAllPools);
