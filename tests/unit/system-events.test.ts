import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";

// Stub server-only so the module can be imported from tests
vi.mock("server-only", () => ({}));

// Stub the pino logger so we can assert on warn calls.
const logWarn = vi.fn();
vi.mock("@/lib/log", () => ({
  log: {
    warn: logWarn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock @/db with a Proxy that delegates to a per-test in-memory drizzle
// instance. Same pattern as tests/helpers/test-db.ts, inlined here so the
// system-events tests stay fully self-contained.
const testDbRef: { current: ReturnType<typeof createTestDb> | null } = {
  current: null,
};
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        const real = testDbRef.current;
        if (!real)
          throw new Error("test db not initialized — beforeEach must set it");
        const value = (real as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(real) : value;
      },
    },
  ),
}));

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      actor_email TEXT,
      project_id TEXT,
      target_type TEXT,
      target_id TEXT,
      summary TEXT NOT NULL,
      duration_ms INTEGER,
      details TEXT
    )
  `);
  return drizzle(sqlite, { schema });
}

// recordEvent must be imported AFTER the mocks are set up; vitest hoists
// `vi.mock` calls to the top of the file, so a top-level import would
// otherwise miss them.
const { recordEvent, buildJobCompletionEvent, buildJobStartEvent, JOB_LABELS } =
  await import("@/lib/system-events");
const { JOB_TYPES } = await import("@/lib/job-types");
type ProcessingJob = schema.ProcessingJob;

beforeEach(() => {
  testDbRef.current = createTestDb();
  logWarn.mockClear();
});

describe("recordEvent", () => {
  it("inserts a row with minimum required fields and DB-defaulted timestamp", async () => {
    await recordEvent({
      source: "cron",
      eventType: "cron_db_backup",
      summary: "Respaldo completado",
    });

    const rows = testDbRef
      .current!.select()
      .from(schema.systemEvents)
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "cron",
      eventType: "cron_db_backup",
      summary: "Respaldo completado",
      severity: "info", // default
      actorEmail: null,
      projectId: null,
      targetType: null,
      targetId: null,
      durationMs: null,
      details: null,
    });
    // DB default fires when occurredAt is omitted
    expect(rows[0].occurredAt).toBeInstanceOf(Date);
  });

  it("normalizes optional fields to null and stringifies details JSON", async () => {
    await recordEvent({
      source: "admin",
      eventType: "permission_changed",
      summary: "Rol cambiado para user@x",
      severity: "success",
      actorEmail: "admin@x",
      projectId: "camera-trap",
      targetType: "user",
      targetId: 42, // numeric — must be coerced to text
      durationMs: 123,
      details: { from: "viewer", to: "editor" },
    });

    const rows = testDbRef
      .current!.select()
      .from(schema.systemEvents)
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].targetId).toBe("42");
    expect(rows[0].details).toBe('{"from":"viewer","to":"editor"}');
    expect(rows[0].durationMs).toBe(123);
    expect(rows[0].severity).toBe("success");
  });

  it("uses caller-supplied occurredAt when provided", async () => {
    const when = new Date("2025-01-01T10:00:00Z");
    await recordEvent({
      source: "cron",
      eventType: "cron_nightly_refresh",
      summary: "test",
      occurredAt: when,
    });

    const rows = testDbRef
      .current!.select()
      .from(schema.systemEvents)
      .all();
    expect(rows[0].occurredAt.toISOString()).toBe(when.toISOString());
  });

  it("swallows DB errors and logs at warn level — caller never sees a throw", async () => {
    // Swap in a broken db that throws on insert
    testDbRef.current = {
      insert: () => ({
        values: () => {
          throw new Error("simulated DB failure");
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(
      recordEvent({
        source: "cron",
        eventType: "cron_db_backup",
        summary: "should not throw",
      }),
    ).resolves.toBeUndefined();

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]?.[1]).toBe("recordEvent_failed");
  });
});

// ---------------------------------------------------------------------------
// buildJobCompletionEvent — pure-function helper for the 28 job-lifecycle
// sites. Tested separately from recordEvent so each property of the mapping
// (source, severity, eventType, projectId, summary, durationMs) is exercised
// without needing the DB.
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: 1,
    deploymentId: 42,
    cameraTrapProjectId: null,
    detectorModel: null,
    classifierModel: null,
    confidenceThreshold: 0.1,
    status: "completed",
    jobType: "birdnet",
    pid: null,
    totalImages: 0,
    processedImages: 0,
    failedImages: 0,
    statusMessage: null,
    errorMessage: null,
    startedAt: new Date(Date.now() - 60_000), // ~60s ago
    completedAt: new Date(),
    createdAt: new Date(),
    createdBy: "tester@x",
    frameExtractionRate: 1.0,
    totalVideos: 0,
    extractedFrames: 0,
    compressFirst: false,
    videoTimestampMethod: "metadata",
    downloadedImages: 0,
    downloadTotal: 0,
    cachedImages: 0,
    ...overrides,
  } as ProcessingJob;
}

describe("buildJobCompletionEvent", () => {
  it("maps a completed BirdNET job to the expected payload", () => {
    const job = makeJob({ status: "completed", jobType: JOB_TYPES.BIRDNET });
    const evt = buildJobCompletionEvent(job, {
      totalDetections: 1234,
      speciesCount: 47,
    });

    expect(evt.source).toBe("audio");
    expect(evt.eventType).toBe("audio_birdnet.completed");
    expect(evt.severity).toBe("success");
    expect(evt.summary).toBe("BirdNET completado · Instalación 42");
    expect(evt.actorEmail).toBe("tester@x");
    expect(evt.projectId).toBe("grabaciones");
    expect(evt.targetType).toBe("processing_job");
    expect(evt.targetId).toBe(1);
    expect(evt.durationMs).toBeGreaterThan(0);
    expect(evt.details).toMatchObject({
      totalDetections: 1234,
      speciesCount: 47,
    });
  });

  it("maps a failed ML job to severity=error and carries errorMessage", () => {
    const job = makeJob({
      status: "failed",
      jobType: JOB_TYPES.ML,
      errorMessage: "Model server crashed",
    });
    const evt = buildJobCompletionEvent(job);

    expect(evt.source).toBe("camera-trap");
    expect(evt.eventType).toBe("camera-trap_ml.failed");
    expect(evt.severity).toBe("error");
    expect(evt.summary).toBe("Detección de especies fallido · Instalación 42");
    expect(evt.projectId).toBe("camera-trap");
    expect(evt.details).toEqual({ errorMessage: "Model server crashed" });
  });

  it("maps a cancelled audio_compression job to severity=warn", () => {
    const job = makeJob({
      status: "cancelled",
      jobType: JOB_TYPES.AUDIO_COMPRESSION,
    });
    const evt = buildJobCompletionEvent(job);

    expect(evt.severity).toBe("warn");
    expect(evt.eventType).toBe("audio_audio_compression.cancelled");
    expect(evt.summary).toBe("Compresión FLAC cancelado · Instalación 42");
  });

  it("uses project scope when deploymentId is null and cameraTrapProjectId is set", () => {
    const job = makeJob({
      status: "completed",
      jobType: JOB_TYPES.DRIVE_SYNC,
      deploymentId: null,
      cameraTrapProjectId: 7,
    });
    const evt = buildJobCompletionEvent(job);

    expect(evt.projectId).toBe("camera-trap:7");
    expect(evt.summary).toBe("Sincronización Drive completado · Proyecto 7");
  });

  it("falls back to 'Todos los proyectos' when neither deployment nor project is set", () => {
    const job = makeJob({
      status: "completed",
      jobType: JOB_TYPES.AUDIO_SYNC,
      deploymentId: null,
      cameraTrapProjectId: null,
    });
    const evt = buildJobCompletionEvent(job);

    expect(evt.summary).toBe(
      "Sincronización de audio completado · Todos los proyectos",
    );
    expect(evt.projectId).toBe("grabaciones");
  });

  it("returns durationMs=null when startedAt is null", () => {
    const job = makeJob({ startedAt: null });
    const evt = buildJobCompletionEvent(job);
    expect(evt.durationMs).toBeNull();
  });

  it("omits errorMessage from details when the job has none", () => {
    const job = makeJob({ status: "completed", errorMessage: null });
    const evt = buildJobCompletionEvent(job);
    expect(evt.details).toEqual({});
  });

  it.each([
    { status: "completed" as const, severity: "success" as const },
    { status: "failed" as const, severity: "error" as const },
    { status: "cancelled" as const, severity: "warn" as const },
  ])(
    "BirdNET $status job round-trips to a system_events row with severity=$severity",
    async ({ status, severity }) => {
      const job = makeJob({ status, jobType: JOB_TYPES.BIRDNET });
      await recordEvent(buildJobCompletionEvent(job));

      const rows = testDbRef
        .current!.select()
        .from(schema.systemEvents)
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "audio",
        eventType: `audio_birdnet.${status}`,
        severity,
        targetType: "processing_job",
        targetId: "1",
      });
    },
  );

  it("round-trips through recordEvent to produce one valid system_events row", async () => {
    const job = makeJob({
      status: "completed",
      jobType: JOB_TYPES.BIRDNET,
    });
    await recordEvent(buildJobCompletionEvent(job, { speciesCount: 12 }));

    const rows = testDbRef
      .current!.select()
      .from(schema.systemEvents)
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "audio",
      eventType: "audio_birdnet.completed",
      severity: "success",
      targetType: "processing_job",
      targetId: "1",
    });
    expect(JSON.parse(rows[0].details!)).toEqual({ speciesCount: 12 });
  });

  describe("coverage guard — every JobType is handled", () => {
    // Catches "added a new job type, forgot to update JOB_LABELS /
    // AUDIO_JOB_TYPES" — the helper must produce a deterministic payload for
    // every value in JOB_TYPES, with a label that isn't just the raw string.
    for (const jobType of Object.values(JOB_TYPES)) {
      it(`handles JobType=${jobType}`, () => {
        const job = makeJob({ status: "completed", jobType });
        const evt = buildJobCompletionEvent(job);

        expect(["audio", "camera-trap"]).toContain(evt.source);
        expect(evt.eventType).toBe(`${evt.source}_${jobType}.completed`);
        expect(JOB_LABELS[jobType]).toBeDefined();
        expect(evt.summary).toContain(JOB_LABELS[jobType]);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// buildJobStartEvent — emitted exactly once when a job transitions
// pending → processing (via claimAndEmitStart in @/lib/job-queue).
// ---------------------------------------------------------------------------

describe("buildJobStartEvent", () => {
  it("emits info severity, *.started eventType, and label in summary", () => {
    const job = makeJob({ status: "processing", jobType: "birdnet" });
    const evt = buildJobStartEvent(job);

    expect(evt.source).toBe("audio");
    expect(evt.eventType).toBe("audio_birdnet.started");
    expect(evt.severity).toBe("info");
    expect(evt.summary).toContain(JOB_LABELS.birdnet);
    expect(evt.summary).toContain("iniciado");
    expect(evt.targetType).toBe("processing_job");
    expect(evt.targetId).toBe(1);
    expect(evt.durationMs).toBeUndefined();
  });

  it("routes camera-trap job types to source=camera-trap", () => {
    const job = makeJob({ status: "processing", jobType: "ml" });
    const evt = buildJobStartEvent(job);
    expect(evt.source).toBe("camera-trap");
    expect(evt.eventType).toBe("camera-trap_ml.started");
  });

  describe("coverage guard — every JobType has a start event", () => {
    for (const jobType of Object.values(JOB_TYPES)) {
      it(`handles JobType=${jobType}`, () => {
        const job = makeJob({ status: "processing", jobType });
        const evt = buildJobStartEvent(job);

        expect(["audio", "camera-trap"]).toContain(evt.source);
        expect(evt.eventType).toBe(`${evt.source}_${jobType}.started`);
        expect(evt.severity).toBe("info");
        expect(JOB_LABELS[jobType]).toBeDefined();
        expect(evt.summary).toContain(JOB_LABELS[jobType]);
        expect(evt.durationMs).toBeUndefined();
      });
    }
  });
});
