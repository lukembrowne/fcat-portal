import { describe, it, expect } from "vitest";
import {
  mapTaxonToClass,
  isLicenseAllowed,
  externalCapForClass,
  EXTERNAL_CAP_PER_CLASS,
  BROCKET_CLASS,
} from "@/lib/external/taxon-map";
import { selectCandidates, type CocoMetadata, type DatasetConfig } from "@/lib/external/lila-source";

describe("mapTaxonToClass — congener policy", () => {
  it("maps ocelot exactly and refuses other Leopardus", () => {
    expect(mapTaxonToClass("Leopardus pardalis")).toBe("Leopardus pardalis");
    expect(mapTaxonToClass("Leopardus wiedii")).toBeNull(); // margay
    expect(mapTaxonToClass("Leopardus tigrinus")).toBeNull(); // oncilla
  });

  it("maps collared peccary (and synonym) but refuses white-lipped", () => {
    expect(mapTaxonToClass("Dicotyles tajacu")).toBe("Dicotyles tajacu");
    expect(mapTaxonToClass("Pecari tajacu")).toBe("Dicotyles tajacu");
    expect(mapTaxonToClass("Tayassu pecari")).toBeNull(); // white-lipped, excluded
  });

  it("maps brocket and spiny-rat at genus level", () => {
    expect(mapTaxonToClass("Mazama americana")).toBe(BROCKET_CLASS);
    expect(mapTaxonToClass("Mazama gualea")).toBe(BROCKET_CLASS);
    expect(mapTaxonToClass("Proechimys semispinosus")).toBe("Proechimys semispinosus");
    expect(mapTaxonToClass("Proechimys guyannensis")).toBe("Proechimys semispinosus");
  });

  it("maps locally-monotypic genera and paca synonym", () => {
    expect(mapTaxonToClass("Dasyprocta fuliginosa")).toBe("Dasyprocta punctata");
    expect(mapTaxonToClass("Cuniculus paca")).toBe("Cuniculus paca");
    expect(mapTaxonToClass("Agouti paca")).toBe("Cuniculus paca");
    expect(mapTaxonToClass("Nasua nasua")).toBe("Nasua narica");
  });

  it("refuses highland/north congeners and unknowns", () => {
    expect(mapTaxonToClass("Cuniculus taczanowskii")).toBeNull(); // mountain paca
    expect(mapTaxonToClass("Procyon lotor")).toBeNull(); // N. raccoon
    expect(mapTaxonToClass("Panthera onca")).toBeNull(); // not a target
    expect(mapTaxonToClass("")).toBeNull();
  });

  it("normalizes case/whitespace/underscores", () => {
    expect(mapTaxonToClass("  leopardus   pardalis ")).toBe("Leopardus pardalis");
    expect(mapTaxonToClass("mazama_americana")).toBe(BROCKET_CLASS);
  });
});

describe("isLicenseAllowed", () => {
  it("accepts CC0 / CDLA-permissive, rejects NC and missing", () => {
    expect(isLicenseAllowed("CC0")).toBe(true);
    expect(isLicenseAllowed("CDLA-Permissive-2.0")).toBe(true);
    expect(
      isLicenseAllowed("Community Data License Agreement – Permissive – Version 1.0"),
    ).toBe(true);
    expect(isLicenseAllowed("CC-BY-NC-4.0")).toBe(false);
    expect(isLicenseAllowed("All Rights Reserved")).toBe(false);
    expect(isLicenseAllowed(null)).toBe(false);
  });
});

describe("externalCapForClass", () => {
  it("returns the flat per-class cap regardless of local data", () => {
    expect(externalCapForClass()).toBe(EXTERNAL_CAP_PER_CLASS);
    expect(EXTERNAL_CAP_PER_CLASS).toBe(1000);
  });
});

describe("selectCandidates", () => {
  const dataset: DatasetConfig = {
    slug: "wcs",
    name: "WCS Camera Traps",
    metadataUrl: "https://example.org/wcs.json",
    mdResultsUrl: "https://example.org/wcs-md.json",
    imageBaseUrl: "https://bucket.example.org/wcs/",
    datasetLicense: "CDLA-Permissive-2.0",
  };

  const metadata: CocoMetadata = {
    categories: [
      { id: 1, name: "ocelot" }, // common name → resolved via taxonomyMap
      { id: 2, name: "margay" },
      { id: 3, name: "Mazama americana" }, // already scientific
      { id: 4, name: "jaguar" }, // not a target
    ],
    images: [
      { id: "i1", file_name: "a.jpg" },
      { id: "i2", file_name: "b.jpg" },
      { id: "i3", file_name: "c.jpg" },
      { id: "i4", file_name: "d.jpg", license: "CC-BY-NC-4.0" }, // disallowed
      { id: "i5", file_name: "e.jpg" },
    ],
    annotations: [
      { image_id: "i1", category_id: 1 }, // ocelot
      { image_id: "i2", category_id: 1 }, // ocelot
      { image_id: "i3", category_id: 3 }, // brocket
      { image_id: "i4", category_id: 3 }, // brocket but NC license → dropped
      { image_id: "i5", category_id: 2 }, // margay → unmapped
      { image_id: "i5", category_id: 4 }, // jaguar → unmapped
    ],
  };

  const taxonomyMap = new Map([
    ["ocelot", "Leopardus pardalis"],
    ["margay", "Leopardus wiedii"],
    ["jaguar", "Panthera onca"],
  ]);

  it("maps via taxonomy, drops unmapped + NC-licensed, caps per class", () => {
    const cap = new Map([
      ["Leopardus pardalis", 1], // cap below available → only 1 kept
      [BROCKET_CLASS, 5],
    ]);
    const out = selectCandidates({ dataset, metadata, capByClass: cap, taxonomyMap });

    const byClass = out.reduce<Record<string, number>>((m, c) => {
      m[c.mappedClass] = (m[c.mappedClass] ?? 0) + 1;
      return m;
    }, {});
    expect(byClass["Leopardus pardalis"]).toBe(1); // capped
    expect(byClass[BROCKET_CLASS]).toBe(1); // i4 dropped (NC), i3 kept
    expect(out.find((c) => c.mappedClass === "Leopardus wiedii")).toBeUndefined();
    const brocket = out.find((c) => c.mappedClass === BROCKET_CLASS)!;
    expect(brocket.sourceUrl).toBe("https://bucket.example.org/wcs/c.jpg");
    expect(brocket.originalTaxon).toBe("Mazama americana");
  });

  it("treats classes absent from the cap map as non-targets (cap 0)", () => {
    const out = selectCandidates({
      dataset,
      metadata,
      capByClass: new Map([[BROCKET_CLASS, 5]]),
      taxonomyMap,
    });
    expect(out.every((c) => c.mappedClass === BROCKET_CLASS)).toBe(true);
  });
});
