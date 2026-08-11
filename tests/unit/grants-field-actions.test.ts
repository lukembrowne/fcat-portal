/**
 * Functional tests for the grant project/period/entity fields in
 * src/app/grants/actions.ts, backed by a real in-memory SQLite DB using the
 * Proxy-delegation pattern from finance-sueldos-actions.test.ts.
 *
 * The DDL mirrors scripts/push-schema.mjs including the funding_entity CHECK, so
 * a write that the enum guard lets through still has to satisfy the database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";

vi.mock("server-only", () => ({}));

const recordEventMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/lib/system-events", () => ({
  recordEvent: (...args: unknown[]) => recordEventMock(...args),
}));

const revalidatePathMock = vi.fn((..._args: unknown[]) => undefined);
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const mockRequirePermission = vi.fn(async (..._args: unknown[]) => ({
  email: "admin@fcat-ecuador.org",
}));
vi.mock("@/lib/auth", () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
  getCurrentUser: (...args: unknown[]) => mockRequirePermission(...args),
}));

const testDbRef: { current: ReturnType<typeof drizzle> | null } = {
  current: null,
};
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        const real = testDbRef.current as unknown as Record<
          string | symbol,
          unknown
        >;
        if (!real) throw new Error("test db not initialized");
        const val = real[prop];
        return typeof val === "function" ? (val as Function).bind(real) : val;
      },
    }
  ),
}));

/** Mirrors scripts/push-schema.mjs — the funding_entity CHECK is on purpose. */
const GRANTS_DDL = `
  CREATE TABLE funders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_normalized TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    funder_id INTEGER REFERENCES funders(id) ON DELETE SET NULL,
    funder_name_raw TEXT,
    name TEXT NOT NULL,
    project_title TEXT,
    website TEXT,
    status TEXT NOT NULL DEFAULT 'to_research' CHECK(status IN ('to_research','in_prep','pending_decision','funded','rejected','passed','completed')),
    amount_requested REAL,
    amount_awarded REAL,
    funding_entity TEXT CHECK(funding_entity IN ('fcat_ecuador','fcat_usa')),
    due_date INTEGER,
    start_date INTEGER,
    end_date INTEGER,
    last_notified_at INTEGER,
    reminders_sent INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    folder_link TEXT,
    budget_link TEXT,
    proposal_link TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE system_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL, event_type TEXT NOT NULL,
    actor_email TEXT, target_type TEXT, target_id TEXT,
    occurred_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

let raw: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockImplementation(async () => ({
    email: "admin@fcat-ecuador.org",
  }));

  raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  raw.exec(GRANTS_DDL);
  testDbRef.current = drizzle(raw, { schema });
});

async function actions() {
  return await import("@/app/grants/actions");
}

function seedGrant(name: string, extra: Record<string, unknown> = {}): number {
  const cols = ["name", ...Object.keys(extra)];
  const placeholders = cols.map(() => "?").join(",");
  const info = raw
    .prepare(`INSERT INTO grants (${cols.join(",")}) VALUES (${placeholders})`)
    .run(name, ...Object.values(extra));
  return Number(info.lastInsertRowid);
}

function row(id: number) {
  return raw.prepare("SELECT * FROM grants WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

describe("updateGrantField — funding entity", () => {
  it("rejects an out-of-enum value without writing", async () => {
    const { updateGrantField } = await actions();
    const id = seedGrant("NSF DEB");

    const res = await updateGrantField(id, "fundingEntity", "fcat_canada");

    expect(res.success).toBe(false);
    expect(row(id).funding_entity).toBeNull();
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("stores a valid entity and returns the canonical value", async () => {
    const { updateGrantField } = await actions();
    const id = seedGrant("NSF DEB");

    const res = await updateGrantField(id, "fundingEntity", "fcat_usa");

    expect(res.success).toBe(true);
    if (res.success) expect(res.data.value).toBe("fcat_usa");
    expect(row(id).funding_entity).toBe("fcat_usa");
    expect(recordEventMock).toHaveBeenCalledTimes(1);
  });

  it("clears the entity back to unset", async () => {
    const { updateGrantField } = await actions();
    const id = seedGrant("NSF DEB", { funding_entity: "fcat_ecuador" });

    const res = await updateGrantField(id, "fundingEntity", "");

    expect(res.success).toBe(true);
    if (res.success) expect(res.data.value).toBeNull();
    expect(row(id).funding_entity).toBeNull();
  });
});

describe("updateGrantField — project period dates", () => {
  it("stores a start date at UTC midnight and reads it back on the same day", async () => {
    // Would come back as the previous day if composed in a negative-offset
    // local timezone — the container runs Eastern.
    const { updateGrantField } = await actions();
    const id = seedGrant("NSF DEB");

    const res = await updateGrantField(id, "startDate", "2026-01-01");

    expect(res.success).toBe(true);
    if (res.success) expect(res.data.value).toBe("2026-01-01");
    const stored = row(id).start_date as number;
    expect(new Date(stored * 1000).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z"
    );
  });

  it("clears a date when the cell is emptied", async () => {
    const { updateGrantField } = await actions();
    const id = seedGrant("NSF DEB");
    await updateGrantField(id, "endDate", "2026-12-31");

    const res = await updateGrantField(id, "endDate", "");

    expect(res.success).toBe(true);
    if (res.success) expect(res.data.value).toBeNull();
    expect(row(id).end_date).toBeNull();
  });

  it("stores a project title", async () => {
    const { updateGrantField } = await actions();
    const id = seedGrant("NSF DEB");

    const res = await updateGrantField(
      id,
      "projectTitle",
      "Chocó Biodiversity Monitoring"
    );

    expect(res.success).toBe(true);
    expect(row(id).project_title).toBe("Chocó Biodiversity Monitoring");
  });
});

describe("updateGrantField — whitelist", () => {
  it("refuses a field outside EDITABLE_GRANT_FIELDS", async () => {
    const { updateGrantField } = await actions();
    const id = seedGrant("NSF DEB");

    const res = await updateGrantField(id, "createdAt", "1700000000");

    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toBe("Unknown field.");
  });
});

describe("getGrants — empty-heavy columns sort their blanks last", () => {
  // SQLite puts NULL before every value in ASC, and a header's first click is
  // always ASC — so without the NULLS-LAST term, one click on Start buries every
  // funded grant under the unfunded ones.
  const JAN_2026 = Math.floor(Date.UTC(2026, 0, 1) / 1000);
  const JUN_2026 = Math.floor(Date.UTC(2026, 5, 1) / 1000);

  beforeEach(() => {
    seedGrant("No period A");
    seedGrant("Has June start", { start_date: JUN_2026 });
    seedGrant("No period B");
    seedGrant("Has Jan start", { start_date: JAN_2026 });
  });

  it("puts populated rows first when sorting start ascending", async () => {
    const { getGrants } = await actions();

    const rows = await getGrants({ sortBy: "start", sortDir: "asc" });

    expect(rows.map((r) => r.name)).toEqual([
      "Has Jan start",
      "Has June start",
      "No period A",
      "No period B",
    ]);
  });

  it("keeps blanks last when sorting start descending too", async () => {
    const { getGrants } = await actions();

    const rows = await getGrants({ sortBy: "start", sortDir: "desc" });

    expect(rows.map((r) => r.name)).toEqual([
      "Has June start",
      "Has Jan start",
      "No period A",
      "No period B",
    ]);
  });

  it("leaves due-date ordering alone — it is populated and long-established", async () => {
    const { getGrants } = await actions();

    const rows = await getGrants({ sortBy: "due", sortDir: "asc" });

    // Every seeded grant has a null due date, so this only asserts the id
    // tiebreaker still governs and no NULLS-LAST term crept in.
    expect(rows.map((r) => r.name)).toEqual([
      "No period A",
      "Has June start",
      "No period B",
      "Has Jan start",
    ]);
  });
});
