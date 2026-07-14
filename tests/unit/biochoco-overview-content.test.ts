import { describe, it, expect } from "vitest";
import { CONTENT } from "@/app/public/biochoco-overview/content";

/** Recursively collect the key-path shape of an object (ignoring array contents). */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe("bilingual content parity", () => {
  it("en and es expose the same key shape (no missing translations)", () => {
    expect(keyPaths(CONTENT.en)).toEqual(keyPaths(CONTENT.es));
  });

  it("has non-empty strings for the headline fields in both languages", () => {
    for (const lang of ["en", "es"] as const) {
      expect(CONTENT[lang].title.length).toBeGreaterThan(0);
      expect(CONTENT[lang].ui.print.length).toBeGreaterThan(0);
      expect(CONTENT[lang].contacts.length).toBeGreaterThan(0);
    }
  });

  it("shares the same real contacts across languages", () => {
    expect(CONTENT.en.contacts).toEqual(CONTENT.es.contacts);
    expect(CONTENT.en.contacts.every((c) => c.email.endsWith("@fcat-ecuador.org"))).toBe(true);
  });
});
