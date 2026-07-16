/**
 * Occupancy common-name language toggle — the pure fallback logic behind the
 * Español ↔ English control on /ocupacion.
 */

import { describe, it, expect } from "vitest";
import { displayCommonName } from "../../src/app/ocupacion/name-lang";

const row = (over: Partial<Parameters<typeof displayCommonName>[0]>) => ({
  species: "Adelomyia melanogenys",
  commonName: null,
  spanishName: null,
  ...over,
});

describe("displayCommonName", () => {
  it("English mode shows the English common name", () => {
    expect(
      displayCommonName(row({ commonName: "Speckled Hummingbird" }), "en"),
    ).toBe("Speckled Hummingbird");
  });

  it("Spanish mode shows the Spanish common name", () => {
    expect(
      displayCommonName(
        row({ commonName: "Speckled Hummingbird", spanishName: "Colibrí Jaspeado" }),
        "es",
      ),
    ).toBe("Colibrí Jaspeado");
  });

  it("Spanish falls back to English when the Spanish name is missing", () => {
    expect(
      displayCommonName(row({ commonName: "Speckled Hummingbird" }), "es"),
    ).toBe("Speckled Hummingbird");
  });

  it("English falls back to the scientific string when unmatched", () => {
    expect(displayCommonName(row({}), "en")).toBe("Adelomyia melanogenys");
  });

  it("Spanish falls all the way back to the scientific string when unmatched", () => {
    expect(displayCommonName(row({}), "es")).toBe("Adelomyia melanogenys");
  });
});
