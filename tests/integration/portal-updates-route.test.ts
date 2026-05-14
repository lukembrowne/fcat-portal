/**
 * Integration tests for the /api/cron/portal-updates route.
 *
 * Mocks Resend at the top level (per MEMORY.md, vi.mock must live in the test
 * file itself, not in a helper). Uses the in-memory testDb for queries.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, testDbRef, setupIntegrationDbMock } from "../helpers/test-db";

setupIntegrationDbMock();

// Resend mock — class with .emails.send
const mockSend = vi.fn();
vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: mockSend };
  },
}));

const route = await import("@/app/api/cron/portal-updates/route");

const VALID_SECRET = "test-cron-secret";

let db: ReturnType<typeof createTestDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;

  process.env.CRON_SECRET = VALID_SECRET;
  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.RESEND_FROM_EMAIL = "portal@example.com";
  process.env.PORTAL_UPDATES_EMAILS = "alice@example.com,bob@example.com";

  // Default: Resend succeeds
  mockSend.mockResolvedValue({ data: { id: "email_123" }, error: null });
});

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/cron/portal-updates", {
    method: "POST",
    headers,
  });
}

function authHeader(secret = VALID_SECRET): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

describe("POST /api/cron/portal-updates — auth", () => {
  it("returns 401 without authorization header", async () => {
    const res = await route.POST(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns 401 with wrong bearer token", async () => {
    const res = await route.POST(makeRequest(authHeader("wrong")));
    expect(res.status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("POST /api/cron/portal-updates — happy path", () => {
  it("sends email and records success event", async () => {
    const res = await route.POST(makeRequest(authHeader()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recipientCount).toBe(2);

    // Resend invoked with the right shape
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendArgs = mockSend.mock.calls[0][0];
    expect(sendArgs.from).toBe("portal@example.com");
    expect(sendArgs.to).toEqual(["alice@example.com", "bob@example.com"]);
    expect(sendArgs.subject).toMatch(/FCAT Portal — /);
    expect(sendArgs.html).toContain("Actividad del Portal");

    // System event recorded
    const events = db.select().from(schema.systemEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("cron");
    expect(events[0].eventType).toBe("cron_portal_updates");
    expect(events[0].severity).toBe("success");
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("subject says 'Sin actividad nueva' when there is no activity", async () => {
    await route.POST(makeRequest(authHeader()));
    const sendArgs = mockSend.mock.calls[0][0];
    expect(sendArgs.subject).toContain("Sin actividad nueva");
    expect(sendArgs.html).toContain("No hubo actividad nueva");
  });
});

describe("POST /api/cron/portal-updates — configuration errors", () => {
  it("returns ok:false + warn event when PORTAL_UPDATES_EMAILS is unset", async () => {
    delete process.env.PORTAL_UPDATES_EMAILS;
    const res = await route.POST(makeRequest(authHeader()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no_recipients");
    expect(mockSend).not.toHaveBeenCalled();

    const events = db.select().from(schema.systemEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("warn");
    expect(events[0].summary).toContain("destinatarios");
  });

  it("returns ok:false when PORTAL_UPDATES_EMAILS is whitespace-only", async () => {
    process.env.PORTAL_UPDATES_EMAILS = " , , ";
    const res = await route.POST(makeRequest(authHeader()));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no_recipients");
  });

  it("returns 500 + error event when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    const res = await route.POST(makeRequest(authHeader()));
    expect(res.status).toBe(500);
    expect(mockSend).not.toHaveBeenCalled();

    const events = db.select().from(schema.systemEvents).all();
    expect(events[0].severity).toBe("error");
    expect(events[0].summary).toContain("RESEND_API_KEY");
  });
});

describe("POST /api/cron/portal-updates — Resend failure", () => {
  it("returns ok:false + warn event when Resend rejects the send", async () => {
    mockSend.mockResolvedValueOnce({
      data: null,
      error: { name: "validation_error", message: "Invalid recipient" },
    });

    const res = await route.POST(makeRequest(authHeader()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();

    const events = db.select().from(schema.systemEvents).all();
    expect(events[0].severity).toBe("warn");
    expect(events[0].summary).toContain("Resend rechazó");
  });
});
