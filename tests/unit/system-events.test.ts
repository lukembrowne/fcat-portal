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
const { recordEvent } = await import("@/lib/system-events");

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
