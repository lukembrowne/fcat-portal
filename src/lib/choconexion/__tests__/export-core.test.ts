import { describe, it, expect } from "vitest";
import path from "node:path";

import {
  EXPORT_ROOT,
  isValidVersion,
  resolveVersionDir,
} from "../export-core";

describe("isValidVersion", () => {
  it("accepts a plain date and a same-day suffix", () => {
    expect(isValidVersion("2026-08-12")).toBe(true);
    expect(isValidVersion("2026-08-12-2")).toBe(true);
  });

  it("rejects traversal attempts", () => {
    // The version segment arrives from the URL and is joined onto a path.
    expect(isValidVersion("..")).toBe(false);
    expect(isValidVersion("../../etc/passwd")).toBe(false);
    expect(isValidVersion("2026-08-12/../..")).toBe(false);
    expect(isValidVersion("2026-08-12/..")).toBe(false);
  });

  it("rejects separators and absolute paths", () => {
    expect(isValidVersion("/etc/passwd")).toBe(false);
    expect(isValidVersion("2026-08-12/x")).toBe(false);
    expect(isValidVersion("2026-08-12\\x")).toBe(false);
  });

  it("rejects null bytes and whitespace padding", () => {
    expect(isValidVersion("2026-08-12\0")).toBe(false);
    expect(isValidVersion(" 2026-08-12")).toBe(false);
    expect(isValidVersion("2026-08-12 ")).toBe(false);
  });

  it("rejects an empty or malformed version", () => {
    expect(isValidVersion("")).toBe(false);
    expect(isValidVersion("v1")).toBe(false);
    expect(isValidVersion("2026-8-12")).toBe(false);
    expect(isValidVersion("latest")).toBe(false);
  });
});

describe("resolveVersionDir", () => {
  it("resolves a valid version under the export root", () => {
    const dir = resolveVersionDir("2026-08-12");
    expect(dir).toBe(path.join(EXPORT_ROOT, "2026-08-12"));
    expect(path.dirname(dir)).toBe(EXPORT_ROOT);
  });

  it("throws rather than resolving a traversal", () => {
    expect(() => resolveVersionDir("../../etc")).toThrow(/inválida/i);
    expect(() => resolveVersionDir("..")).toThrow(/inválida/i);
  });

  it("never escapes the export root for any accepted version", () => {
    for (const v of ["2026-01-01", "2026-12-31-9", "2026-08-12-12"]) {
      expect(path.dirname(resolveVersionDir(v))).toBe(EXPORT_ROOT);
    }
  });
});
