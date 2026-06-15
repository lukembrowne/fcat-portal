/**
 * Tests for GET /api/field-upload/v1/credential.
 *
 * Hands the desktop app its service-account credential once at first run. No DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET } = await import("@/app/api/field-upload/v1/credential/route");
const { __resetRateLimitForTests } = await import("@/lib/simple-rate-limit");

const TOKEN = "test-token";
// base64 of {"type":"service_account","project_id":"x"}
const SA_OBJECT = { type: "service_account", project_id: "x" };
const SA_B64 = Buffer.from(JSON.stringify(SA_OBJECT)).toString("base64");

function call(opts: { token?: string; ip?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  return GET(new Request("http://localhost/api/field-upload/v1/credential", { headers }));
}

const ORIGINAL = { ...process.env };

beforeEach(() => {
  __resetRateLimitForTests();
  vi.clearAllMocks();
  process.env.FIELD_UPLOAD_TOKEN = TOKEN;
  process.env.FIELD_UPLOAD_SA_KEY = SA_B64;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("GET /api/field-upload/v1/credential", () => {
  it("401 without a valid token", async () => {
    expect((await call()).status).toBe(401);
    expect((await call({ token: "wrong" })).status).toBe(401);
  });

  it("503 when the SA key is not configured", async () => {
    delete process.env.FIELD_UPLOAD_SA_KEY;
    expect((await call({ token: TOKEN })).status).toBe(503);
  });

  it("500 when the SA key is not valid base64 JSON", async () => {
    process.env.FIELD_UPLOAD_SA_KEY = Buffer.from("not json").toString("base64");
    expect((await call({ token: TOKEN })).status).toBe(500);
  });

  it("200 returns the decoded SA JSON with no-store", async () => {
    const res = await call({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(SA_OBJECT);
  });

  it("429 once the tight per-IP window is exhausted (limit 10)", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call({ token: TOKEN, ip: "9.9.9.9" })).status).toBe(200);
    }
    expect((await call({ token: TOKEN, ip: "9.9.9.9" })).status).toBe(429);
  });
});
