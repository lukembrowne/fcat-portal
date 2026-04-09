import { describe, it, expect } from "vitest";
import { isValidShareToken, UUID_V4_REGEX } from "@/lib/public-tokens";

describe("isValidShareToken", () => {
  it("accepts a valid lowercase UUID v4", () => {
    expect(isValidShareToken("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")).toBe(true);
  });

  it("accepts a valid uppercase UUID v4", () => {
    expect(isValidShareToken("A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D")).toBe(true);
  });

  it("accepts the output of crypto.randomUUID()", () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidShareToken(crypto.randomUUID())).toBe(true);
    }
  });

  it("rejects empty string", () => {
    expect(isValidShareToken("")).toBe(false);
  });

  it("rejects null/undefined/non-strings", () => {
    expect(isValidShareToken(null)).toBe(false);
    expect(isValidShareToken(undefined)).toBe(false);
    expect(isValidShareToken(123)).toBe(false);
    expect(isValidShareToken({})).toBe(false);
  });

  it("rejects strings with the wrong shape", () => {
    expect(isValidShareToken("not-a-uuid")).toBe(false);
    expect(isValidShareToken("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5")).toBe(false); // missing 1 char
    expect(isValidShareToken("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5dd")).toBe(false); // extra char
  });

  it("rejects non-v4 UUIDs (wrong version digit)", () => {
    // Version 1 UUID — version digit at position 14 is "1" not "4"
    expect(isValidShareToken("a1b2c3d4-e5f6-1a7b-8c9d-0e1f2a3b4c5d")).toBe(false);
  });

  it("rejects UUIDs with bad variant bits", () => {
    // Variant digit at position 19 must be 8/9/a/b. "c" is invalid.
    expect(isValidShareToken("a1b2c3d4-e5f6-4a7b-cc9d-0e1f2a3b4c5d")).toBe(false);
  });

  it("rejects SQL-injection attempts", () => {
    expect(isValidShareToken("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' OR 1=1--")).toBe(
      false
    );
    expect(isValidShareToken("'; DROP TABLE site_share_tokens; --")).toBe(false);
  });

  it("UUID_V4_REGEX is exported and matches the validator", () => {
    const token = crypto.randomUUID();
    expect(UUID_V4_REGEX.test(token)).toBe(true);
  });
});
