import { describe, it, expect } from "vitest";
import {
  PROJECT_CONTEXT_BLURB,
  PAGE_SHARE_MESSAGE,
  buildWhatsAppShareUrl,
  presentIucnStatuses,
  starredGallerySeed,
  landownerDisplayName,
  sortSpeciesForTable,
  speciesCommonName,
  iucnSeverityRank,
} from "../copy";

describe("species table ordering (SpeciesTable)", () => {
  const mk = (
    speciesName: string,
    iucnStatus: string | null,
    detectionCount: number,
    spanishName: string | null = null,
  ) => ({
    speciesName,
    spanishName,
    commonName: null,
    detectionCount,
    iucnStatus,
  });

  it("ranks more-at-risk codes higher; DD/null lowest", () => {
    expect(iucnSeverityRank("CR")).toBeGreaterThan(iucnSeverityRank("LC"));
    expect(iucnSeverityRank("EN")).toBeGreaterThan(iucnSeverityRank("VU"));
    expect(iucnSeverityRank(null)).toBe(-1);
    expect(iucnSeverityRank("DD")).toBe(-1);
  });

  it("sorts most-at-risk first, then detections desc, then name", () => {
    const out = sortSpeciesForTable([
      mk("Aaa aaa", "LC", 5),
      mk("Zzz zzz", "CR", 1),
      mk("Bbb bbb", "LC", 20),
      mk("Ccc ccc", null, 100),
    ]).map((s) => s.speciesName);
    // CR first; then the two LC by detections desc (Bbb 20 before Aaa 5);
    // then null/DD last regardless of its high detection count.
    expect(out).toEqual(["Zzz zzz", "Bbb bbb", "Aaa aaa", "Ccc ccc"]);
  });

  it("does not mutate the input array", () => {
    const input = [mk("B", "LC", 1), mk("A", "CR", 1)];
    const before = input.map((s) => s.speciesName);
    sortSpeciesForTable(input);
    expect(input.map((s) => s.speciesName)).toEqual(before);
  });

  it("common name prefers Spanish, falls back to scientific", () => {
    expect(speciesCommonName(mk("Panthera onca", "NT", 1, "Jaguar"))).toBe(
      "Jaguar",
    );
    expect(speciesCommonName(mk("Panthera onca", "NT", 1))).toBe(
      "Panthera onca",
    );
  });
});

describe("landownerDisplayName", () => {
  it("drops the internal code and returns the name portion", () => {
    expect(landownerDisplayName("GIZ-009 - Carla Barreto")).toBe(
      "Carla Barreto",
    );
  });
  it("does not split a bare code (hyphen without surrounding spaces)", () => {
    expect(landownerDisplayName("SEC-014")).toBe("SEC-014");
  });
  it("preserves a name that itself contains ' - '", () => {
    expect(landownerDisplayName("GIZ-009 - Ana - María López")).toBe(
      "Ana - María López",
    );
  });
  it("falls back to the full string when there is no name portion", () => {
    expect(landownerDisplayName("GIZ-009 - ")).toBe("GIZ-009 -");
  });
});

describe("PROJECT_CONTEXT_BLURB (U6)", () => {
  it("is the exact user-approved Spanish copy (95% / four-questions framing)", () => {
    expect(PROJECT_CONTEXT_BLURB).toBe(
      "El Chocó es uno de los bosques lluviosos más biodiversos de la Tierra, y más del 95% de su bosque original ya ha desaparecido. Lo que queda es un mosaico de bosque, fincas de cacao y pastizal. ¿Cómo responde la biodiversidad a estos cambios en el uso de la tierra? ¿Cómo podemos diseñar intervenciones de conservación que maximicen los beneficios para las comunidades locales y la biodiversidad? BioChocó trabaja para responder estas preguntas.",
    );
  });
});

describe("presentIucnStatuses (U8)", () => {
  it("returns only statuses present among the species, in severity order", () => {
    const species = [
      { iucnStatus: "EN" },
      { iucnStatus: "LC" },
      { iucnStatus: "en" }, // duplicate, case-insensitive
      { iucnStatus: "VU" },
    ];
    expect(presentIucnStatuses(species)).toEqual(["LC", "VU", "EN"]);
  });

  it("excludes DD, unknown, empty, and null (iucnChip → null)", () => {
    const species = [
      { iucnStatus: "DD" },
      { iucnStatus: "" },
      { iucnStatus: null },
      { iucnStatus: undefined as unknown as string },
      { iucnStatus: "NOPE" },
      { iucnStatus: "NT" },
    ];
    expect(presentIucnStatuses(species)).toEqual(["NT"]);
  });

  it("returns an empty array when no species carry an assessed status", () => {
    expect(presentIucnStatuses([{ iucnStatus: "DD" }, { iucnStatus: null }])).toEqual(
      [],
    );
  });
});

describe("buildWhatsAppShareUrl / PAGE_SHARE_MESSAGE (U12)", () => {
  it("uses the approved default share message", () => {
    expect(PAGE_SHARE_MESSAGE).toBe("Mira lo que vive en su tierra 🌿 — BioChoco");
  });

  it("encodes the message + page URL into a wa.me link", () => {
    const url = "https://portal.fcat-ecuador.org/public/biochoco/tok123";
    const wa = buildWhatsAppShareUrl(url);
    expect(wa).toBe(
      `https://wa.me/?text=${encodeURIComponent(`${PAGE_SHARE_MESSAGE} ${url}`)}`,
    );
    // The decoded text carries both the message and the exact URL.
    const decoded = decodeURIComponent(wa.split("text=")[1]);
    expect(decoded).toContain(PAGE_SHARE_MESSAGE);
    expect(decoded).toContain(url);
  });
});

describe("starredGallerySeed (U11)", () => {
  it("seeds from the full starred set, starting at the tapped id", () => {
    const starred = [10, 20, 30, 40];
    const block = [20, 40];
    expect(starredGallerySeed(starred, block, 30)).toEqual({
      ids: starred,
      startIndex: 2,
    });
  });

  it("falls back to the block ids when the starred set is empty", () => {
    const block = [7, 8, 9];
    expect(starredGallerySeed([], block, 8)).toEqual({
      ids: block,
      startIndex: 1,
    });
  });

  it("starts at index 0 when the tapped id is not in the effective set", () => {
    const starred = [1, 2, 3];
    expect(starredGallerySeed(starred, [99], 99)).toEqual({
      ids: starred,
      startIndex: 0,
    });
  });
});
