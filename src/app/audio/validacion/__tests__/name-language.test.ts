import { describe, it, expect } from "vitest";

import {
  parseNameLang,
  resolveDisplayName,
  describeDisplayName,
  fallbackNote,
  otherLangLabel,
} from "../name-language";

describe("parseNameLang", () => {
  it("reads the English preference", () => {
    expect(parseNameLang("en")).toBe("en");
  });

  it("reads the Spanish preference", () => {
    expect(parseNameLang("es")).toBe("es");
  });

  it("defaults to Spanish when the cookie is absent or unrecognised", () => {
    expect(parseNameLang(undefined)).toBe("es");
    expect(parseNameLang(null)).toBe("es");
    expect(parseNameLang("")).toBe("es");
    expect(parseNameLang("fr")).toBe("es");
  });
});

describe("resolveDisplayName", () => {
  const full = {
    scientificName: "Ramphastos ambiguus",
    commonName: "Yellow-throated Toucan",
    spanishName: "Tucán del Chocó",
  };

  it("returns the Spanish name under the Spanish preference", () => {
    expect(resolveDisplayName(full, "es")).toBe("Tucán del Chocó");
  });

  it("returns the English name under the English preference", () => {
    expect(resolveDisplayName(full, "en")).toBe("Yellow-throated Toucan");
  });

  it("falls back to English when there is no Spanish name", () => {
    // The real case for 26 of the 554 species with detections.
    expect(
      resolveDisplayName({ ...full, spanishName: null }, "es")
    ).toBe("Yellow-throated Toucan");
  });

  it("falls back to the scientific name when neither common name exists", () => {
    expect(
      resolveDisplayName(
        { scientificName: "Mystery labelus", commonName: null, spanishName: null },
        "es"
      )
    ).toBe("Mystery labelus");
  });

  it("falls back to the scientific name under English with no English name", () => {
    expect(
      resolveDisplayName({ ...full, commonName: null }, "en")
    ).toBe("Ramphastos ambiguus");
  });

  it("prefers English over Spanish under the English preference, never the reverse", () => {
    // Guards against a fallback chain that quietly returns Spanish for an
    // English reader just because the Spanish column is populated.
    expect(resolveDisplayName(full, "en")).not.toBe("Tucán del Chocó");
  });

  it("treats an empty or whitespace name as absent", () => {
    expect(resolveDisplayName({ ...full, spanishName: "" }, "es")).toBe(
      "Yellow-throated Toucan"
    );
    expect(resolveDisplayName({ ...full, spanishName: "   " }, "es")).toBe(
      "Yellow-throated Toucan"
    );
    expect(
      resolveDisplayName(
        { scientificName: "Aaa bbb", commonName: "  ", spanishName: "" },
        "en"
      )
    ).toBe("Aaa bbb");
  });

  it("tolerates absent optional fields entirely", () => {
    expect(resolveDisplayName({ scientificName: "Aaa bbb" }, "es")).toBe("Aaa bbb");
    expect(resolveDisplayName({ scientificName: "Aaa bbb" }, "en")).toBe("Aaa bbb");
  });

  it("trims the returned name", () => {
    expect(
      resolveDisplayName({ ...full, spanishName: "  Tucán  " }, "es")
    ).toBe("Tucán");
  });
});

describe("describeDisplayName", () => {
  const full = {
    scientificName: "Ramphastos ambiguus",
    commonName: "Yellow-throated Toucan",
    spanishName: "Tucán Pechigualdo",
  };

  it("reports no fallback when the asked-for language has a name", () => {
    expect(describeDisplayName(full, "es")).toEqual({
      name: "Tucán Pechigualdo",
      fallback: null,
    });
    expect(describeDisplayName(full, "en")).toEqual({
      name: "Yellow-throated Toucan",
      fallback: null,
    });
  });

  it("flags the borrowed name that makes the toggle look broken", () => {
    // `Aramides wolfi` in the live data: English name only, so a Spanish reader
    // sees "Brown wood-rail" and switching to English changes nothing visible.
    expect(
      describeDisplayName(
        {
          scientificName: "Aramides wolfi",
          commonName: "Brown wood-rail",
          spanishName: null,
        },
        "es"
      )
    ).toEqual({ name: "Brown wood-rail", fallback: "other-language" });
  });

  it("flags a scientific-name fallback when no common name applies", () => {
    expect(
      describeDisplayName(
        { scientificName: "Mystery labelus", commonName: null, spanishName: null },
        "es"
      )
    ).toEqual({ name: "Mystery labelus", fallback: "scientific" });
  });

  it("never borrows the Spanish name for an English reader", () => {
    // The name matches resolveDisplayName's rule; the point here is that the
    // fallback is REPORTED rather than silently looking like a real English name.
    expect(describeDisplayName({ ...full, commonName: null }, "en")).toEqual({
      name: "Ramphastos ambiguus",
      fallback: "scientific",
    });
  });

  it("agrees with resolveDisplayName on every branch", () => {
    const cases = [
      full,
      { ...full, spanishName: null },
      { ...full, commonName: null },
      { scientificName: "Solo nomen" },
    ];
    for (const sp of cases) {
      for (const lang of ["es", "en"] as const) {
        expect(describeDisplayName(sp, lang).name).toBe(
          resolveDisplayName(sp, lang)
        );
      }
    }
  });
});

describe("fallbackNote", () => {
  it("says nothing when the name is the one that was asked for", () => {
    expect(fallbackNote(null, "es")).toBeNull();
    expect(fallbackNote(null, "en")).toBeNull();
  });

  it("names the missing language, not the toggle", () => {
    expect(fallbackNote("other-language", "es")).toBe("sin nombre en español");
  });

  it("reports a missing English name rather than 'no common name'", () => {
    // Under English the chain never borrows Spanish, so reaching the scientific
    // name says English is absent — a Spanish name may well exist.
    expect(fallbackNote("scientific", "en")).toBe("sin nombre en inglés");
    expect(fallbackNote("other-language", "en")).toBe("sin nombre en inglés");
  });

  it("reports no common name at all only under Spanish", () => {
    expect(fallbackNote("scientific", "es")).toBe("sin nombre común");
  });
});

describe("otherLangLabel", () => {
  it("names the language the toggle switches TO", () => {
    expect(otherLangLabel("es")).toBe("English");
    expect(otherLangLabel("en")).toBe("Español");
  });
});
