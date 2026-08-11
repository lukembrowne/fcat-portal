/**
 * Schema-level tests for the grants.funding_entity CHECK constraint.
 *
 * Two things are locked in here:
 *
 * 1. The constraint behaves correctly when attached via ALTER TABLE ADD COLUMN
 *    on a table that already has rows — the production shape, where ~119 legacy
 *    grants must migrate untouched. NULL has to satisfy the CHECK or the
 *    migration fails outright.
 *
 * 2. The TypeScript enum and the SQLite CHECK do not drift. Drizzle's
 *    `text({ enum })` is types-only: adding a third entity value passes
 *    typecheck and every other test, then throws SQLITE_CONSTRAINT_CHECK at
 *    runtime the first time someone selects it. This is a repeat failure mode in
 *    this codebase, so the guard reads the real DDL rather than a copy.
 *
 * Uses in-memory SQLite with the same DDL as scripts/push-schema.mjs, following
 * tests/unit/site-share-tokens-schema.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { grantFundingEntityEnum } from "@/db/schema";

const PUSH_SCHEMA_PATH = path.join(process.cwd(), "scripts/push-schema.mjs");

/**
 * Builds grants at its PRE-migration shape, seeds legacy rows, then applies the
 * ALTER — exercising the migration path real databases take, not the fresh
 * CREATE path they never see.
 */
function createMigratedDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount_requested REAL,
      amount_awarded REAL,
      due_date INTEGER
    );
  `);
  const insert = sqlite.prepare("INSERT INTO grants (name) VALUES (?)");
  for (let i = 0; i < 5; i++) insert.run(`Legacy grant ${i}`);

  sqlite.exec(`
    ALTER TABLE grants ADD COLUMN project_title TEXT;
    ALTER TABLE grants ADD COLUMN funding_entity TEXT
      CHECK(funding_entity IN ('fcat_ecuador','fcat_usa'));
    ALTER TABLE grants ADD COLUMN start_date INTEGER;
    ALTER TABLE grants ADD COLUMN end_date INTEGER;
  `);
  return sqlite;
}

describe("grants.funding_entity CHECK survives ALTER TABLE ADD COLUMN", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedDb();
  });

  it("leaves every pre-existing row with a NULL entity", () => {
    const { total, unset } = db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(funding_entity IS NULL) AS unset FROM grants"
      )
      .get() as { total: number; unset: number };
    expect(total).toBe(5);
    expect(unset).toBe(5);
  });

  it("accepts every enum value", () => {
    for (const entity of grantFundingEntityEnum) {
      expect(() =>
        db
          .prepare("INSERT INTO grants (name, funding_entity) VALUES (?, ?)")
          .run(`Grant ${entity}`, entity)
      ).not.toThrow();
    }
  });

  it("accepts a grant with no entity — unset is a valid state", () => {
    expect(() =>
      db.prepare("INSERT INTO grants (name) VALUES (?)").run("Unfunded")
    ).not.toThrow();
  });

  it("rejects an out-of-enum value on insert", () => {
    expect(() =>
      db
        .prepare("INSERT INTO grants (name, funding_entity) VALUES (?, ?)")
        .run("Bad", "fcat_canada")
    ).toThrow(/CHECK/i);
  });

  it("rejects an out-of-enum value on update of a legacy row", () => {
    expect(() =>
      db
        .prepare("UPDATE grants SET funding_entity = ? WHERE id = 1")
        .run("fcat_canada")
    ).toThrow(/CHECK/i);
  });
});

describe("funding_entity CHECK matches the TypeScript enum", () => {
  const ddl = readFileSync(PUSH_SCHEMA_PATH, "utf8");

  /** Every `funding_entity IN (...)` clause in the real migration script. */
  function checkClauses(): string[][] {
    const matches = [
      ...ddl.matchAll(/funding_entity IN \(([^)]*)\)/g),
    ] as RegExpMatchArray[];
    return matches.map((m) =>
      m[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""))
    );
  }

  it("declares the CHECK in both the CREATE TABLE and the ALTER", () => {
    // Fresh databases get it from CREATE TABLE; existing ones from the ALTER.
    // Only one of the two ever runs on a given database, so both must carry it.
    expect(checkClauses().length).toBe(2);
  });

  it("lists exactly the enum values, with nothing extra", () => {
    for (const values of checkClauses()) {
      expect([...values].sort()).toEqual([...grantFundingEntityEnum].sort());
    }
  });
});
