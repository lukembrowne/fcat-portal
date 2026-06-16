/**
 * Auth + project allow-listing for the field-upload endpoint.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  verifyFieldUploadToken,
  isProjectAllowed,
  getAllowedProjects,
} from "@/lib/field-upload-auth";

function req(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return new Request("http://localhost/x", { headers });
}

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.FIELD_UPLOAD_TOKEN = "s3cret-token";
  process.env.FIELD_UPLOAD_ALLOWED_PROJECTS = "BioChoco, Otra ";
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("verifyFieldUploadToken", () => {
  it("accepts the exact Bearer token", () => {
    expect(verifyFieldUploadToken(req("Bearer s3cret-token"))).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(verifyFieldUploadToken(req("Bearer nope"))).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    expect(verifyFieldUploadToken(req())).toBe(false);
  });

  it("rejects a token without the Bearer prefix", () => {
    expect(verifyFieldUploadToken(req("s3cret-token"))).toBe(false);
  });

  it("rejects when FIELD_UPLOAD_TOKEN is unset (fail closed)", () => {
    delete process.env.FIELD_UPLOAD_TOKEN;
    expect(verifyFieldUploadToken(req("Bearer s3cret-token"))).toBe(false);
  });

  it("does not throw on differing lengths", () => {
    expect(verifyFieldUploadToken(req("Bearer x"))).toBe(false);
  });
});

describe("isProjectAllowed", () => {
  it("allows a trimmed allow-listed project", () => {
    expect(isProjectAllowed("BioChoco")).toBe(true);
    expect(isProjectAllowed("Otra")).toBe(true);
  });

  it("refuses a non-allow-listed project", () => {
    expect(isProjectAllowed("Finance")).toBe(false);
  });

  it("refuses everything when the allow-list is empty (fail closed)", () => {
    delete process.env.FIELD_UPLOAD_ALLOWED_PROJECTS;
    expect(getAllowedProjects()).toEqual([]);
    expect(isProjectAllowed("BioChoco")).toBe(false);
  });
});
