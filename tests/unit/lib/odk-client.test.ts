/**
 * Tests for ODK Central API client.
 *
 * Mocks global fetch to verify:
 * - Pagination through large result sets
 * - Empty result handling
 * - 401 token refresh with singleton promise
 * - API error propagation
 * - Attachment (binary) fetching
 * - parseWktPoint pure function
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.stubEnv("ODK_CENTRAL_URL", "https://odk.test.org");
vi.stubEnv("ODK_CENTRAL_EMAIL", "test@test.org");
vi.stubEnv("ODK_CENTRAL_PASSWORD", "secret123");

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Dynamic import after mocks
const {
  fetchSubmissions,
  fetchEntities,
  fetchAttachment,
  fetchRepeatData,
  parseWktPoint,
} = await import("@/lib/odk-client");

/** Route-based fetch mock: auto-handles auth, delegates data to dataHandler */
function setupFetchMock(dataHandler: (url: string) => Response | Promise<Response>) {
  mockFetch.mockImplementation(async (url: string) => {
    // Auth endpoint
    if (url.includes("/v1/sessions")) {
      return new Response(
        JSON.stringify({ token: "test-token" }),
        { status: 200 }
      );
    }
    return dataHandler(url);
  });
}

/** OData JSON response body */
function odata(value: unknown[]) {
  return new Response(JSON.stringify({ value }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

// === parseWktPoint (pure function) ===

describe("parseWktPoint", () => {
  it("parses POINT with lon lat", () => {
    expect(parseWktPoint("POINT (-79.5 -0.25)")).toEqual({
      lat: -0.25,
      lng: -79.5,
    });
  });

  it("parses POINT with lon lat elevation", () => {
    expect(parseWktPoint("POINT (-79.123 0.456 250.0)")).toEqual({
      lat: 0.456,
      lng: -79.123,
    });
  });

  it("handles case-insensitive POINT", () => {
    expect(parseWktPoint("point (10 20)")).toEqual({ lat: 20, lng: 10 });
  });

  it("returns null for null/undefined", () => {
    expect(parseWktPoint(null)).toBeNull();
    expect(parseWktPoint(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseWktPoint("")).toBeNull();
  });

  it("returns null for non-POINT WKT", () => {
    expect(parseWktPoint("LINESTRING (0 0, 1 1)")).toBeNull();
  });

  it("returns null for malformed POINT", () => {
    expect(parseWktPoint("POINT ()")).toBeNull();
  });
});

// === fetchSubmissions ===

describe("fetchSubmissions", () => {
  it("fetches a single page of submissions", async () => {
    setupFetchMock(() =>
      odata([
        { __id: "s1", field: "a" },
        { __id: "s2", field: "b" },
      ])
    );

    const result = await fetchSubmissions("1", "form1");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ __id: "s1", field: "a" });

    // Verify URL construction
    const dataCall = mockFetch.mock.calls.find(
      (c: unknown[]) => !(c[0] as string).includes("/sessions")
    );
    expect(dataCall![0]).toContain("/v1/projects/1/forms/form1.svc/Submissions");
    expect(dataCall![0]).toContain("top=250");
    expect(dataCall![0]).toContain("skip=0");
  });

  it("paginates through multiple pages", async () => {
    let callCount = 0;
    setupFetchMock(() => {
      callCount++;
      if (callCount === 1) {
        // Page 1: full page (250 items)
        return odata(
          Array.from({ length: 250 }, (_, i) => ({ __id: `s${i}` }))
        );
      }
      // Page 2: partial page
      return odata(
        Array.from({ length: 10 }, (_, i) => ({ __id: `s${250 + i}` }))
      );
    });

    const result = await fetchSubmissions("1", "form1");
    expect(result).toHaveLength(260);

    // Verify $skip=250 in second data call
    const dataCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => !(c[0] as string).includes("/sessions")
    );
    expect(dataCalls).toHaveLength(2);
    expect(dataCalls[1][0]).toContain("skip=250");
  });

  it("returns empty array for empty result", async () => {
    setupFetchMock(() => odata([]));

    const result = await fetchSubmissions("1", "form1");
    expect(result).toHaveLength(0);
  });

  it("applies since filter", async () => {
    setupFetchMock(() => odata([]));

    await fetchSubmissions("1", "form1", { since: "2025-01-01T00:00:00Z" });

    const dataCall = mockFetch.mock.calls.find(
      (c: unknown[]) => !(c[0] as string).includes("/sessions")
    );
    expect(dataCall![0]).toContain("filter=__system");
    expect(dataCall![0]).toContain("submissionDate");
    expect(dataCall![0]).toContain("2025-01-01");
  });

  it("flattens nested objects when flatten=true", async () => {
    setupFetchMock(() =>
      odata([
        {
          __id: "s1",
          grupo: { campo1: "a", campo2: "b" },
          simple: "val",
        },
      ])
    );

    const result = await fetchSubmissions("1", "form1", { flatten: true });
    expect(result[0]).toEqual({
      __id: "s1",
      grupo_campo1: "a",
      grupo_campo2: "b",
      simple: "val",
    });
  });

  it("throws on API error", async () => {
    setupFetchMock(() =>
      new Response("Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    await expect(fetchSubmissions("1", "form1")).rejects.toThrow(
      "ODK fetch failed: 500"
    );
  });

  it("retries on 401 with fresh token", async () => {
    let dataCallCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if ((url as string).includes("/v1/sessions")) {
        return new Response(
          JSON.stringify({ token: `token-${Date.now()}` }),
          { status: 200 }
        );
      }
      dataCallCount++;
      if (dataCallCount === 1) {
        // First data call returns 401
        return new Response("Unauthorized", { status: 401 });
      }
      // Retry succeeds
      return odata([{ __id: "s1" }]);
    });

    const result = await fetchSubmissions("1", "form1");
    expect(result).toHaveLength(1);
    // At least 2 data calls (401 + retry) plus auth calls
    expect(dataCallCount).toBe(2);
  });
});

// === fetchEntities ===

describe("fetchEntities", () => {
  it("fetches entities and flattens __id to uuid", async () => {
    setupFetchMock(() =>
      odata([
        {
          __id: "uuid-123",
          label: "Site 1",
          site_id: "S1",
          habitat: "forest",
        },
      ])
    );

    const result = await fetchEntities("8", "monitoring_sites");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      uuid: "uuid-123",
      label: "Site 1",
      site_id: "S1",
      habitat: "forest",
    });
  });

  it("strips __ system keys except __id", async () => {
    setupFetchMock(() =>
      odata([
        {
          __id: "uuid-1",
          __system: { submitterName: "test" },
          label: "L",
          field: "val",
        },
      ])
    );

    const result = await fetchEntities("8", "dataset");
    expect(result[0]).toEqual({
      uuid: "uuid-1",
      label: "L",
      field: "val",
    });
    expect(result[0]).not.toHaveProperty("__system");
  });

  it("paginates through multiple pages", async () => {
    let callCount = 0;
    setupFetchMock(() => {
      callCount++;
      if (callCount === 1) {
        return odata(
          Array.from({ length: 250 }, (_, i) => ({
            __id: `u${i}`,
            label: `E${i}`,
          }))
        );
      }
      return odata(
        Array.from({ length: 5 }, (_, i) => ({
          __id: `u${250 + i}`,
          label: `E${250 + i}`,
        }))
      );
    });

    const result = await fetchEntities("8", "sites");
    expect(result).toHaveLength(255);
  });

  it("returns empty array for no entities", async () => {
    setupFetchMock(() => odata([]));

    const result = await fetchEntities("8", "sites");
    expect(result).toHaveLength(0);
  });

  it("throws on API error", async () => {
    setupFetchMock(
      () =>
        new Response("Not Found", { status: 404, statusText: "Not Found" })
    );

    await expect(fetchEntities("8", "missing_dataset")).rejects.toThrow(
      "ODK entities fetch failed: 404"
    );
  });
});

// === fetchAttachment ===

describe("fetchAttachment", () => {
  it("returns response for valid attachment", async () => {
    setupFetchMock(() =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      })
    );

    const res = await fetchAttachment(
      "1",
      "form1",
      "instance-uuid",
      "photo.jpg"
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");

    // Verify URL construction
    const dataCall = mockFetch.mock.calls.find(
      (c: unknown[]) => !(c[0] as string).includes("/sessions")
    );
    expect(dataCall![0]).toContain(
      "/v1/projects/1/forms/form1/submissions/instance-uuid/attachments/photo.jpg"
    );
  });

  it("throws on 404", async () => {
    setupFetchMock(() => new Response("Not Found", { status: 404 }));

    await expect(
      fetchAttachment("1", "form1", "uuid", "missing.jpg")
    ).rejects.toThrow("ODK attachment fetch failed: 404");
  });
});

// === fetchRepeatData ===

describe("fetchRepeatData", () => {
  it("fetches repeat group data", async () => {
    setupFetchMock(() =>
      odata([
        { __id: "r1", foto: "img1.jpg" },
        { __id: "r2", foto: "img2.jpg" },
      ])
    );

    const result = await fetchRepeatData("8", "form1", "fotos");
    expect(result).toHaveLength(2);

    const dataCall = mockFetch.mock.calls.find(
      (c: unknown[]) => !(c[0] as string).includes("/sessions")
    );
    expect(dataCall![0]).toContain("/forms/form1.svc/Submissions.fotos");
  });

  it("paginates repeat data", async () => {
    let callCount = 0;
    setupFetchMock(() => {
      callCount++;
      if (callCount === 1) {
        return odata(
          Array.from({ length: 250 }, (_, i) => ({ __id: `r${i}` }))
        );
      }
      return odata([{ __id: "r250" }]);
    });

    const result = await fetchRepeatData("8", "form1", "fotos");
    expect(result).toHaveLength(251);
  });

  it("throws on API error", async () => {
    setupFetchMock(
      () =>
        new Response("Error", {
          status: 503,
          statusText: "Service Unavailable",
        })
    );

    await expect(fetchRepeatData("8", "form1", "fotos")).rejects.toThrow(
      "ODK repeat fetch failed: 503"
    );
  });
});

// === Token management ===

describe("token caching", () => {
  it("reuses cached token across calls (single auth)", async () => {
    setupFetchMock(() => odata([]));

    await fetchSubmissions("1", "form1");
    await fetchEntities("1", "dataset");

    // Count auth calls — at most 1
    const authCalls = mockFetch.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes("/sessions")
    );
    expect(authCalls.length).toBeLessThanOrEqual(1);
  });
});

describe("auth failure", () => {
  it("throws on auth endpoint failure", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if ((url as string).includes("/v1/sessions")) {
        return new Response("Forbidden", {
          status: 403,
          statusText: "Forbidden",
        });
      }
      // Data call returns 401 to trigger re-auth
      return new Response("Unauthorized", { status: 401 });
    });

    // This should eventually throw when re-auth fails
    await expect(fetchSubmissions("1", "form1")).rejects.toThrow();
  });
});
