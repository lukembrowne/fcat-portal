import { describe, expect, it } from "vitest";
import {
  activeIdentification,
  correctedIdentification,
  effectiveSpeciesMatches,
} from "@/db/effective-species";
import { audioIdentifications, identifications } from "@/db/schema";

describe("effectiveSpeciesMatches", () => {
  it("returns a Drizzle SQL fragment for the camera-trap table", () => {
    const fragment = effectiveSpeciesMatches(identifications, "Ramphastos ambiguus");
    expect(fragment).toBeDefined();
    expect(typeof fragment).toBe("object");
  });

  it("returns a Drizzle SQL fragment for the audio table", () => {
    const fragment = effectiveSpeciesMatches(
      audioIdentifications,
      "Ramphastos ambiguus"
    );
    expect(fragment).toBeDefined();
    expect(typeof fragment).toBe("object");
  });

  it("does not throw on edge species names", () => {
    expect(() => effectiveSpeciesMatches(identifications, "")).not.toThrow();
    expect(() => effectiveSpeciesMatches(identifications, "O'Hara")).not.toThrow();
    expect(() => effectiveSpeciesMatches(identifications, "; DROP TABLE")).not.toThrow();
  });
});

describe("activeIdentification / correctedIdentification", () => {
  it("returns SQL fragments for both tables", () => {
    expect(activeIdentification(identifications)).toBeDefined();
    expect(activeIdentification(audioIdentifications)).toBeDefined();
    expect(correctedIdentification(identifications)).toBeDefined();
    expect(correctedIdentification(audioIdentifications)).toBeDefined();
  });
});
