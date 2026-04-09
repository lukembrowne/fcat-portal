/**
 * Schema-level test for site_share_tokens.
 *
 * Locks in the unique partial index that enforces "one active token per
 * biochoco site". Without this index, race conditions and stale data
 * could leave multiple active tokens for the same site, which the public
 * page resolution would silently pick one of arbitrarily.
 *
 * Uses an in-memory SQLite via better-sqlite3 with the same DDL as
 * scripts/push-schema.mjs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE site_share_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      biochoco_site_id TEXT NOT NULL,
      deployment_ids TEXT NOT NULL,
      hero_image_id INTEGER,
      created_by TEXT NOT NULL,
      label TEXT,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_site_share_tokens_token ON site_share_tokens(token);
    CREATE UNIQUE INDEX idx_site_share_tokens_site_active
      ON site_share_tokens(biochoco_site_id) WHERE revoked_at IS NULL;
  `);

  return sqlite;
}

describe("site_share_tokens partial unique index", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  function insertToken(opts: {
    token: string;
    siteId: string;
    revokedAt?: number | null;
  }) {
    db.prepare(
      `INSERT INTO site_share_tokens
       (token, biochoco_site_id, deployment_ids, created_by, revoked_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      opts.token,
      opts.siteId,
      "[1,2]",
      "user@example.com",
      opts.revokedAt ?? null
    );
  }

  it("allows a single active token for a site", () => {
    expect(() =>
      insertToken({ token: "tok-a", siteId: "NAC-005" })
    ).not.toThrow();
  });

  it("rejects a second active token for the same site", () => {
    insertToken({ token: "tok-a", siteId: "NAC-005" });
    expect(() =>
      insertToken({ token: "tok-b", siteId: "NAC-005" })
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("allows a new active token after the first is revoked", () => {
    insertToken({ token: "tok-a", siteId: "NAC-005" });
    db.prepare(
      `UPDATE site_share_tokens SET revoked_at = unixepoch() WHERE token = ?`
    ).run("tok-a");
    expect(() =>
      insertToken({ token: "tok-b", siteId: "NAC-005" })
    ).not.toThrow();
  });

  it("allows multiple revoked tokens for the same site", () => {
    insertToken({
      token: "tok-a",
      siteId: "NAC-005",
      revokedAt: 1000,
    });
    insertToken({
      token: "tok-b",
      siteId: "NAC-005",
      revokedAt: 2000,
    });
    insertToken({
      token: "tok-c",
      siteId: "NAC-005",
      revokedAt: 3000,
    });
    insertToken({ token: "tok-d", siteId: "NAC-005" });
    const count = db
      .prepare(
        `SELECT COUNT(*) as c FROM site_share_tokens WHERE biochoco_site_id = 'NAC-005'`
      )
      .get() as { c: number };
    expect(count.c).toBe(4);
  });

  it("allows active tokens for different sites simultaneously", () => {
    insertToken({ token: "tok-a", siteId: "NAC-005" });
    expect(() =>
      insertToken({ token: "tok-b", siteId: "NAC-012" })
    ).not.toThrow();
    expect(() =>
      insertToken({ token: "tok-c", siteId: "SEC-001" })
    ).not.toThrow();
  });

  it("enforces token uniqueness even across revoked rows", () => {
    insertToken({
      token: "tok-a",
      siteId: "NAC-005",
      revokedAt: 1000,
    });
    expect(() =>
      insertToken({
        token: "tok-a",
        siteId: "NAC-012",
      })
    ).toThrow(/UNIQUE constraint failed/i);
  });
});
