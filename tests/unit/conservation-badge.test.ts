import { describe, it, expect } from "vitest";
import { getConservationInfo } from "@/components/conservation-badge";

describe("getConservationInfo", () => {
  it("returns a Spanish label for threatened categories", () => {
    expect(getConservationInfo("EN")?.label).toBe("En peligro");
    expect(getConservationInfo("CR")?.label).toBe("En peligro crítico");
    expect(getConservationInfo("VU")?.label).toBe("Vulnerable");
    expect(getConservationInfo("NT")?.label).toBe("Casi amenazada");
  });

  it("is case-insensitive on the code", () => {
    expect(getConservationInfo("en")?.label).toBe("En peligro");
  });

  it("returns null for non-threatened, unknown, or missing status", () => {
    expect(getConservationInfo("LC")).toBeNull();
    expect(getConservationInfo("DD")).toBeNull();
    expect(getConservationInfo("EX")).toBeNull();
    expect(getConservationInfo("")).toBeNull();
    expect(getConservationInfo(null)).toBeNull();
    expect(getConservationInfo(undefined)).toBeNull();
  });

  it("never exposes the raw code in the label", () => {
    for (const code of ["CR", "EN", "VU", "NT"]) {
      expect(getConservationInfo(code)?.label).not.toContain(code);
    }
  });
});
