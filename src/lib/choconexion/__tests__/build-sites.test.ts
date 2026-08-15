import { describe, it, expect } from "vitest";

import {
  assembleSites,
  classifyState,
  datePart,
  daysBetween,
  resolveNames,
  resolveWindow,
  uploadedCount,
  type DeploymentRow,
  type SpeciesMetaRow,
  type SpeciesTallyRow,
  type SiteInputs,
} from "../build-sites";

// ---------------------------------------------------------------------------
// Fixtures, shaped like the real rows
// ---------------------------------------------------------------------------

const dep = (over: Partial<DeploymentRow> = {}): DeploymentRow => ({
  id: 1,
  name: "REF-007_V1",
  latitude: 0.380093432,
  longitude: -79.66060772,
  dateStart: "2026-03-25",
  dateEnd: "2026-04-25",
  validStart: "2026-03-25T10:25",
  validEnd: "2026-04-25T06:29",
  imageRows: 102,
  processedImages: 102,
  totalImages: 102,
  uploadCameraCount: 102,
  ...over,
});

const META: SpeciesMetaRow[] = [
  { scientificName: "Dasyprocta punctata", commonName: "Central American agouti", spanishName: "Guatusa", type: "mammal", taxonomicRank: "species" },
  { scientificName: "Leopardus pardalis", commonName: "Ocelot", spanishName: "Tigrillo", type: "mammal", taxonomicRank: "species" },
  { scientificName: "Cuniculus paca", commonName: "Paca", spanishName: "Guanta", type: "mammal", taxonomicRank: "species" },
  { scientificName: "Crypturellus soui", commonName: "Little tinamou", spanishName: null, type: "bird", taxonomicRank: "species" },
  { scientificName: "Aves", commonName: "Bird (unidentified)", spanishName: null, type: "bird", taxonomicRank: "class" },
  { scientificName: "Rodentia", commonName: "Rodent", spanishName: null, type: "mammal", taxonomicRank: "order" },
  { scientificName: "Unknown", commonName: "Animal (unidentified)", spanishName: null, type: "system", taxonomicRank: "species" },
  { scientificName: "Equus caballus", commonName: "Horse", spanishName: "Caballo", type: "mammal", taxonomicRank: "species" },
];

const speciesMeta = new Map(META.map((m) => [m.scientificName, m]));

const inputs = (
  deployments: DeploymentRow[],
  tallies: SpeciesTallyRow[] = [],
): SiteInputs => ({ deployments, tallies, speciesMeta });

const siteOf = (result: ReturnType<typeof assembleSites>, plotId: string) =>
  result.sites.find((s) => s.plotId === plotId)!;

// ---------------------------------------------------------------------------

describe("datePart", () => {
  it("takes the date from a bare date and from a wall-clock timestamp", () => {
    expect(datePart("2026-03-11")).toBe("2026-03-11");
    expect(datePart("2026-03-11T11:52")).toBe("2026-03-11");
  });

  it("returns null for null, empty, and unparseable values", () => {
    expect(datePart(null)).toBeNull();
    expect(datePart("")).toBeNull();
    expect(datePart("   ")).toBeNull();
    expect(datePart("not a date")).toBeNull();
  });
});

describe("daysBetween", () => {
  it("matches the real deployment durations", () => {
    expect(daysBetween("2026-03-11", "2026-03-23")).toBe(12); // REF-001
    expect(daysBetween("2026-01-25", "2026-02-24")).toBe(30); // REF-002
    expect(daysBetween("2026-03-18", "2026-04-18")).toBe(31); // REF-005
    expect(daysBetween("2026-02-12", "2026-03-13")).toBe(29); // REF-010
  });

  it("returns null when the end precedes the start", () => {
    expect(daysBetween("2026-04-18", "2026-03-18")).toBeNull();
  });

  it("does not shift the day when running in a UTC container", () => {
    // Composing through a local-timezone Date would make this 11 or 13 depending
    // on the host offset. The parse is UTC-anchored precisely to avoid that.
    expect(daysBetween("2026-03-11", "2026-03-23")).toBe(12);
  });
});

describe("resolveWindow", () => {
  it("prefers the validated dates over ODK's", () => {
    // REF-001: date_start == date_end, so only the validated window shows the
    // real 12-day span. This is the case that motivates the preference.
    const w = resolveWindow(
      dep({ dateStart: "2026-03-11", dateEnd: "2026-03-11", validStart: "2026-03-11T11:52", validEnd: "2026-03-23T18:16" }),
    );
    expect(w).toMatchObject({ start: "2026-03-11", end: "2026-03-23", days: 12, validated: true });
  });

  it("falls back to the ODK dates when no validated window exists", () => {
    const w = resolveWindow(dep({ validStart: null, validEnd: null, dateStart: "2026-03-12", dateEnd: "2026-04-12" }));
    expect(w).toMatchObject({ start: "2026-03-12", end: "2026-04-12", days: 31, validated: false });
  });

  it("reports a duration when date_end is open but a validated end exists", () => {
    // REF-004 in production: still open in ODK, but QA recorded a real end.
    const w = resolveWindow(dep({ dateEnd: null, validStart: "2026-05-23T12:04", validEnd: "2026-06-20T10:01" }));
    expect(w).toMatchObject({ start: "2026-05-23", end: "2026-06-20", days: 28 });
  });

  it("reports a null end and null duration for a genuinely open deployment", () => {
    // Never a span computed to today — that would grow on every re-export.
    const w = resolveWindow(dep({ dateEnd: null, validStart: null, validEnd: null }));
    expect(w).toMatchObject({ end: null, days: null });
  });

  it("returns null when there is no start date at all", () => {
    expect(resolveWindow(dep({ dateStart: null, validStart: null }))).toBeNull();
  });
});

describe("resolveNames", () => {
  it("emits all three forms when the lookup has them", () => {
    expect(resolveNames("Dasyprocta punctata", speciesMeta.get("Dasyprocta punctata"))).toEqual({
      scientific: "Dasyprocta punctata",
      english: "Central American agouti",
      spanish: "Guatusa",
    });
  });

  it("leaves spanish null rather than filling it with the English name", () => {
    // The viewer needs to tell "no Spanish name yet" from "Spanish name that
    // happens to match", so the fallback happens at render time, not here.
    expect(resolveNames("Crypturellus soui", speciesMeta.get("Crypturellus soui"))).toEqual({
      scientific: "Crypturellus soui",
      english: "Little tinamou",
      spanish: null,
    });
  });

  it("falls back to the scientific name when the lookup has no entry", () => {
    expect(resolveNames("Genus novum", undefined)).toEqual({
      scientific: "Genus novum",
      english: "Genus novum",
      spanish: null,
    });
  });
});

describe("uploadedCount", () => {
  it("takes the largest counter, since the Drive cache can undercount", () => {
    // PRI-002 in the real data: 616 image rows, upload_camera_count 573.
    expect(uploadedCount(dep({ imageRows: 616, totalImages: 616, uploadCameraCount: 573 }))).toBe(616);
  });

  it("treats null counters as zero", () => {
    expect(uploadedCount(dep({ imageRows: 0, totalImages: null, uploadCameraCount: null }))).toBe(0);
  });
});

describe("classifyState", () => {
  it("returns no-data when the site has no deployment row at all", () => {
    // P08 / SEC-002 today.
    expect(classifyState(undefined, 0)).toBe("no-data");
  });

  it("returns no-data when nothing has been uploaded", () => {
    expect(classifyState(dep({ imageRows: 0, totalImages: 0, uploadCameraCount: 0 }), 0)).toBe("no-data");
  });

  it("returns unprocessed when images are uploaded but none are processed", () => {
    expect(classifyState(dep({ imageRows: 259, processedImages: 0, totalImages: 259 }), 0)).toBe("unprocessed");
  });

  it("returns no-species when processed with nothing confirmed", () => {
    expect(classifyState(dep(), 0)).toBe("no-species");
  });

  it("returns results when at least one wild species is confirmed", () => {
    expect(classifyState(dep(), 1)).toBe("results");
  });
});

describe("assembleSites", () => {
  it("emits all 16 plots even when most have no data", () => {
    const result = assembleSites(inputs([]));
    expect(result.sites).toHaveLength(16);
    expect(result.sites.map((s) => s.plotId)).toEqual(
      Array.from({ length: 16 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`),
    );
    expect(result.sites.every((s) => s.state === "no-data")).toBe(true);
  });

  it("counts a corrected identification under its corrected species", () => {
    // The tally query already resolves COALESCE(corrected_species, species);
    // this pins that the assembled record uses that effective label.
    const result = assembleSites(
      inputs([dep({ id: 7, name: "REF-007_V1" })], [
        { deploymentId: 7, eff: "Leopardus pardalis", detections: 3 },
      ]),
    );
    expect(siteOf(result, "P07").species).toEqual([
      { scientific: "Leopardus pardalis", english: "Ocelot", spanish: "Tigrillo", detections: 3 },
    ]);
  });

  it("excludes bucket classes and system labels from the species list", () => {
    // REF-002's real tally: after filtering, one species and three detections,
    // which is exactly what the brainstorm's table records for P02.
    const result = assembleSites(
      inputs([dep({ id: 2, name: "REF-002_V1", imageRows: 22, processedImages: 22 })], [
        { deploymentId: 2, eff: "Aves", detections: 15 },
        { deploymentId: 2, eff: "Dasyprocta punctata", detections: 3 },
        { deploymentId: 2, eff: "Rodentia", detections: 1 },
        { deploymentId: 2, eff: "Unknown", detections: 1 },
      ]),
    );
    const p02 = siteOf(result, "P02");
    expect(p02.species).toHaveLength(1);
    expect(p02.species[0]).toMatchObject({ scientific: "Dasyprocta punctata", detections: 3 });
  });

  it("excludes domestic animals, so P10 reports one species and not two", () => {
    // REF-010's real tally. AE2 turns on the horse being dropped.
    const result = assembleSites(
      inputs([dep({ id: 10, name: "REF-010_V1", imageRows: 29, processedImages: 29 })], [
        { deploymentId: 10, eff: "Dasyprocta punctata", detections: 17 },
        { deploymentId: 10, eff: "Equus caballus", detections: 10 },
      ]),
    );
    const p10 = siteOf(result, "P10");
    expect(p10.species.map((s) => s.scientific)).toEqual(["Dasyprocta punctata"]);
    expect(p10.species[0].detections).toBe(17);
  });

  it("classifies a site whose only labels are buckets as no-species, not results", () => {
    // REF-001: a single Unknown. The panel must show the 12-day window and say
    // nothing was confirmed, not render an unexplained empty list.
    const result = assembleSites(
      inputs([dep({ id: 1, name: "REF-001_V1", imageRows: 3, processedImages: 3, validStart: "2026-03-11T11:52", validEnd: "2026-03-23T18:16" })], [
        { deploymentId: 1, eff: "Unknown", detections: 1 },
      ]),
    );
    const p01 = siteOf(result, "P01");
    expect(p01.state).toBe("no-species");
    expect(p01.species).toEqual([]);
    expect(p01.window).toMatchObject({ days: 12 });
  });

  it("carries the pending count only in the unprocessed state", () => {
    const result = assembleSites(
      inputs([dep({ id: 12, name: "REF-012_V1", imageRows: 259, processedImages: 0, totalImages: 259 })]),
    );
    const p12 = siteOf(result, "P12");
    expect(p12.state).toBe("unprocessed");
    expect(p12.pendingImages).toBe(259);
    expect(siteOf(result, "P07").pendingImages).toBeNull();
  });

  it("sorts species by detections descending with a stable tiebreak", () => {
    const result = assembleSites(
      inputs([dep({ id: 5, name: "REF-005_V1" })], [
        { deploymentId: 5, eff: "Cuniculus paca", detections: 6 },
        { deploymentId: 5, eff: "Dasyprocta punctata", detections: 8 },
        { deploymentId: 5, eff: "Leopardus pardalis", detections: 6 },
      ]),
    );
    expect(siteOf(result, "P05").species.map((s) => s.scientific)).toEqual([
      "Dasyprocta punctata",
      "Cuniculus paca",
      "Leopardus pardalis",
    ]);
  });

  it("builds a roster counting plots, not detections", () => {
    const result = assembleSites(
      inputs(
        [
          dep({ id: 7, name: "REF-007_V1" }),
          dep({ id: 11, name: "REF-011_V1" }),
        ],
        [
          { deploymentId: 7, eff: "Dasyprocta punctata", detections: 40 },
          { deploymentId: 11, eff: "Dasyprocta punctata", detections: 18 },
          { deploymentId: 11, eff: "Leopardus pardalis", detections: 1 },
        ],
      ),
    );
    expect(result.species).toEqual([
      { scientific: "Dasyprocta punctata", english: "Central American agouti", spanish: "Guatusa", plots: 2, detections: 58 },
      { scientific: "Leopardus pardalis", english: "Ocelot", spanish: "Tigrillo", plots: 1, detections: 1 },
    ]);
  });

  it("keeps a bucket class out of the roster too", () => {
    const result = assembleSites(
      inputs([dep({ id: 7 })], [{ deploymentId: 7, eff: "Aves", detections: 13 }]),
    );
    expect(result.species).toEqual([]);
  });

  it("reprojects the position into the plot cluster", () => {
    const result = assembleSites(inputs([dep({ id: 7, name: "REF-007_V1" })]));
    const p07 = siteOf(result, "P07");
    expect(p07.x).toBeGreaterThan(648_600);
    expect(p07.x).toBeLessThan(649_300);
    expect(p07.y).toBeGreaterThan(41_000);
  });

  it("drops an implausible position and warns rather than placing a marker 40 km away", () => {
    const result = assembleSites(
      inputs([dep({ id: 7, name: "REF-007_V1", latitude: 0.4441, longitude: -79.7086 })]),
    );
    expect(siteOf(result, "P07").x).toBeNull();
    expect(result.warnings.join(" ")).toContain("REF-007");
  });

  it("warns when a deployment has no coordinates", () => {
    const result = assembleSites(
      inputs([dep({ id: 7, name: "REF-007_V1", latitude: null, longitude: null })]),
    );
    expect(siteOf(result, "P07").x).toBeNull();
    expect(result.warnings.join(" ")).toContain("coordenadas");
  });

  it("emits no landowner name in any record field", () => {
    // Deployment names embed them ("PRI-002 - Don Adrian"); only the code travels.
    const result = assembleSites(
      inputs([dep({ id: 16, name: "PRI-002_V1 - Don Adrian" })]),
    );
    const serialized = JSON.stringify(siteOf(result, "P16"));
    expect(serialized).not.toContain("Adrian");
    expect(siteOf(result, "P16").siteCode).toBe("PRI-002");
  });

  it("leaves media empty — the media steps fill it", () => {
    const result = assembleSites(inputs([dep({ id: 7 })]));
    expect(siteOf(result, "P07").photos).toEqual([]);
    expect(siteOf(result, "P07").soundscapes).toEqual([]);
  });

  it("is deterministic across runs on identical input", () => {
    const build = () =>
      assembleSites(
        inputs([dep({ id: 7 }), dep({ id: 11, name: "REF-011_V1" })], [
          { deploymentId: 7, eff: "Dasyprocta punctata", detections: 40 },
          { deploymentId: 11, eff: "Leopardus pardalis", detections: 1 },
        ]),
      );
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});
