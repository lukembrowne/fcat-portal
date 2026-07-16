/**
 * Tests for recordSiteView() — the fire-and-forget public-page view tracker.
 *
 * recordSiteView must:
 * - guard on isValidShareToken (real, unmocked) — invalid tokens never touch
 *   the DB and never throw;
 * - issue a single db.update on site_share_tokens with a Date lastViewedAt and
 *   SQL fragments for the viewCount increment + firstViewedAt COALESCE;
 * - swallow any DB error (a tracking write must never break the render).
 *
 * The DB is mocked with a tiny hand-rolled chain so we can both assert the
 * shape of the .set() payload and simulate a rejected write. We do NOT assert
 * the exact incremented counts here — the +1 / COALESCE happen inside SQLite
 * (opaque to this mock); that behavior is exercised via the SQL fragments and
 * left to integration coverage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable mock state controlling the db.update(...).set(...).where(...) chain.
let whereShouldReject = false;
const updateCalls: unknown[] = [];
const setPayloads: Record<string, unknown>[] = [];

vi.mock("@/db", () => ({
  db: {
    update: (table: unknown) => {
      updateCalls.push(table);
      return {
        set: (payload: Record<string, unknown>) => {
          setPayloads.push(payload);
          return {
            where: () =>
              whereShouldReject
                ? Promise.reject(new Error("simulated DB error"))
                : Promise.resolve([]),
          };
        },
      };
    },
  },
}));

import { recordSiteView } from "@/app/biochoco/resultados/actions";

const VALID_TOKEN = "3f9a1c2e-7b4d-4e8a-9c1f-2b6d0a5e8f31"; // UUID v4

beforeEach(() => {
  whereShouldReject = false;
  updateCalls.length = 0;
  setPayloads.length = 0;
});

describe("recordSiteView", () => {
  it("no-ops on an invalid token (no DB call, no throw)", async () => {
    await expect(recordSiteView("not-a-uuid")).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(0);
    expect(setPayloads).toHaveLength(0);
  });

  it("no-ops on an empty token", async () => {
    await expect(recordSiteView("")).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(0);
  });

  it("issues one update with the expected set-payload shape for a valid token", async () => {
    await expect(recordSiteView(VALID_TOKEN)).resolves.toBeUndefined();

    expect(updateCalls).toHaveLength(1);
    expect(setPayloads).toHaveLength(1);

    const payload = setPayloads[0];
    // lastViewedAt is a JS Date (Drizzle mode:"timestamp" → seconds on write),
    // NOT a raw ms number — guards the seconds-vs-ms gotcha.
    expect(payload.lastViewedAt).toBeInstanceOf(Date);
    // viewCount + firstViewedAt are drizzle SQL fragments (objects), not
    // plain JS values — the +1 / COALESCE run inside SQLite.
    expect(payload.viewCount).toBeTypeOf("object");
    expect(payload.firstViewedAt).toBeTypeOf("object");
    expect(payload.viewCount).not.toBeInstanceOf(Date);
  });

  it("swallows a DB error and never throws", async () => {
    whereShouldReject = true;
    await expect(recordSiteView(VALID_TOKEN)).resolves.toBeUndefined();
    // The update was attempted before the failure.
    expect(updateCalls).toHaveLength(1);
  });
});
