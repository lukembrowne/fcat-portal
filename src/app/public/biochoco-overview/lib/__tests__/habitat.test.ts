import { describe, it, expect } from "vitest";
import { countSitesByHabitat, habitatForSite, HAB_ORDER } from "../habitat";
import rawHabitatMap from "../habitat-map.json";

describe("habitatForSite", () => {
  it("resolves every three-letter site-code prefix", () => {
    expect(habitatForSite("PRI-001")).toBe("primary_forest");
    expect(habitatForSite("SEC-002")).toBe("secondary_forest");
    expect(habitatForSite("NAC-014")).toBe("cacao_nacional");
    expect(habitatForSite("GIZ-006")).toBe("cacao_giz");
    expect(habitatForSite("CCN-002")).toBe("cacao_ccn");
    expect(habitatForSite("REF-001")).toBe("reforestation");
    expect(habitatForSite("POT-006")).toBe("pasture");
  });

  it("classifies site codes added after habitat-map.json was frozen", () => {
    // These exist as deployments in production but are absent from the JSON —
    // they used to render as "Sin clasificar" on the public map.
    for (const code of ["PRI-010", "PRI-012", "POT-006", "POT-007", "CCN-002", "SEC-002"]) {
      expect(code in (rawHabitatMap as Record<string, unknown>)).toBe(false);
      expect(habitatForSite(code)).not.toBe("unknown");
    }
  });

  it("agrees with every pinned entry in habitat-map.json", () => {
    for (const [code, habitat] of Object.entries(rawHabitatMap as Record<string, string>)) {
      expect(habitatForSite(code)).toBe(habitat);
      // The pin is redundant with the prefix rule — no exceptions exist today.
      const derived = /^([A-Za-z]{3})-\d/.exec(code)?.[1];
      expect(derived).toBeDefined();
    }
  });

  it("leaves non-site-code deployment names unknown", () => {
    expect(habitatForSite("Datos de comparacion de Ibuto")).toBe("unknown");
    expect(habitatForSite("")).toBe("unknown");
    expect(habitatForSite("PRIMARY")).toBe("unknown");
  });

  it("counts distinct sites per habitat, de-duplicating codes", () => {
    const counts = countSitesByHabitat(["PRI-001", "PRI-001", "PRI-010", "POT-006", "junk"]);
    expect(counts.primary_forest).toBe(2);
    expect(counts.pasture).toBe(1);
    expect(counts.unknown).toBe(1);
  });

  it("keeps every derivable habitat inside the legend's display order", () => {
    for (const key of ["PRI", "SEC", "NAC", "GIZ", "CCN", "REF", "POT"]) {
      expect(HAB_ORDER).toContain(habitatForSite(`${key}-001`));
    }
  });
});
