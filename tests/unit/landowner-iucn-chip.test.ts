import { describe, expect, it } from "vitest";
import { iucnChip } from "@/lib/landowner/iucn-chip";

describe("iucnChip", () => {
  it("maps LC to 'Preocupación menor' with a color", () => {
    const chip = iucnChip("LC");
    expect(chip).not.toBeNull();
    expect(chip?.label).toBe("Preocupación menor");
    expect(chip?.color).toMatch(/^#/);
  });

  it("maps NT to 'Casi amenazado'", () => {
    expect(iucnChip("NT")?.label).toBe("Casi amenazado");
  });

  it("maps VU/EN/CR to correct Spanish labels", () => {
    expect(iucnChip("VU")?.label).toBe("Vulnerable");
    expect(iucnChip("EN")?.label).toBe("En peligro");
    expect(iucnChip("CR")?.label).toBe("En peligro crítico");
  });

  it("gives VU/EN/CR distinct escalating-severity colors", () => {
    const colors = [
      iucnChip("VU")?.color,
      iucnChip("EN")?.color,
      iucnChip("CR")?.color,
    ];
    expect(new Set(colors).size).toBe(3);
    for (const c of colors) expect(c).toMatch(/^#/);
  });

  it("maps EW/EX to extinction labels", () => {
    expect(iucnChip("EW")?.label).toBe("Extinto en estado silvestre");
    expect(iucnChip("EX")?.label).toBe("Extinto");
  });

  it("is case-insensitive", () => {
    expect(iucnChip("lc")).toEqual(iucnChip("LC"));
    expect(iucnChip("  vu ")?.label).toBe("Vulnerable");
  });

  it("returns null for DD / unknown / empty / null / undefined", () => {
    expect(iucnChip("DD")).toBeNull();
    expect(iucnChip("XX")).toBeNull();
    expect(iucnChip("")).toBeNull();
    expect(iucnChip("   ")).toBeNull();
    expect(iucnChip(null)).toBeNull();
    expect(iucnChip(undefined)).toBeNull();
  });
});
