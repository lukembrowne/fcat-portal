/**
 * `isRetriableDriveError` — regression test for gaxios error-shape handling.
 *
 * gaxios v7 moved the Google API `reason` off the top-level `errors` array
 * (it now lives under `cause.errors` / `response.data.error.errors`). The
 * original helper only checked the top level, so rate-limit 403s were treated
 * as non-retriable and a full Shared Drive count died mid-pagination. These
 * cases pin every shape we've seen on the wire.
 */

import { describe, it, expect, vi } from "vitest";

// Block googleapis so the server-only module loads without a real SA.
vi.mock("googleapis", () => ({
  google: { drive: () => ({}), auth: { GoogleAuth: class {} } },
}));

process.env.GOOGLE_SERVICE_ACCOUNT_KEY = Buffer.from(
  JSON.stringify({ type: "service_account" }),
).toString("base64");

const { isRetriableDriveError } = await import("@/lib/drive-client");

describe("isRetriableDriveError", () => {
  it("retries 429", () => {
    expect(isRetriableDriveError({ code: 429 })).toBe(true);
  });

  it("retries 5xx", () => {
    expect(isRetriableDriveError({ code: 503 })).toBe(true);
    expect(isRetriableDriveError({ response: { status: 500 } })).toBe(true);
  });

  it("retries 403 userRateLimitExceeded — top-level errors (legacy shape)", () => {
    expect(
      isRetriableDriveError({ code: 403, errors: [{ reason: "userRateLimitExceeded" }] }),
    ).toBe(true);
  });

  it("retries 403 userRateLimitExceeded — gaxios v7 cause.errors", () => {
    expect(
      isRetriableDriveError({
        code: 403,
        message: "User rate limit exceeded.",
        cause: { errors: [{ reason: "userRateLimitExceeded" }] },
      }),
    ).toBe(true);
  });

  it("retries 403 rateLimitExceeded — response.data.error.errors", () => {
    expect(
      isRetriableDriveError({
        code: 403,
        response: { data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
      }),
    ).toBe(true);
  });

  it("retries 403 by message fallback when no reason is present", () => {
    expect(
      isRetriableDriveError({ code: 403, message: "User rate limit exceeded." }),
    ).toBe(true);
  });

  it("does NOT retry a 403 permission error (membership/forbidden)", () => {
    expect(
      isRetriableDriveError({
        code: 403,
        message: "The attempted action requires shared drive membership.",
        cause: { errors: [{ reason: "insufficientFilePermissions" }] },
      }),
    ).toBe(false);
  });

  it("does NOT retry 404 / 400 / unknown", () => {
    expect(isRetriableDriveError({ code: 404 })).toBe(false);
    expect(isRetriableDriveError({ code: 400 })).toBe(false);
    expect(isRetriableDriveError(new Error("boom"))).toBe(false);
  });
});
