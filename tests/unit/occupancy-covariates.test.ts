import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  parseSeedCovariates,
  resolveSiteCovariates,
  toCovariateSpecs,
  persistSiteCovariateSnapshot,
  type SiteCovariateInput,
} from "@/lib/occupancy/covariates";

const seedNotes = (forest: number, elevation: number, habitat: string) =>
  JSON.stringify({ occSeed: { forest, elevation, habitat } });

const site = (id: string, fieldNotes: string | null): SiteCovariateInput => ({
  siteId: id,
  siteName: `S${id}`,
  deploymentName: `S${id}_V1`,
  latitude: 0.4,
  longitude: -79.6,
  fieldNotes,
});

describe("parseSeedCovariates", () => {
  it("parses the occSeed blob", () => {
    expect(parseSeedCovariates(seedNotes(0.8, 600, "bosque maduro"))).toEqual({
      forest: 0.8,
      elevation: 600,
      habitat: "bosque maduro",
    });
  });
  it("returns null for absent/invalid notes", () => {
    expect(parseSeedCovariates(null)).toBeNull();
    expect(parseSeedCovariates("not json")).toBeNull();
    expect(parseSeedCovariates(JSON.stringify({ other: 1 }))).toBeNull();
  });
});

describe("resolveSiteCovariates", () => {
  it("uses the dev seed blob when present", () => {
    const raw = resolveSiteCovariates([site("1", seedNotes(0.7, 500, "borde"))]);
    expect(raw[0]).toMatchObject({ forestCover: 0.7, elevation: 500, habitat: "borde" });
  });

  it("falls back to resolvers for non-seed sites", () => {
    const raw = resolveSiteCovariates([site("42", null)], {
      forestCover: () => 0.33,
      elevation: () => 820,
      habitat: () => "pasto",
    });
    expect(raw[0]).toMatchObject({ forestCover: 0.33, elevation: 820, habitat: "pasto" });
  });

  it("yields nulls when neither seed nor resolver provides a value", () => {
    const raw = resolveSiteCovariates([site("9", null)]);
    expect(raw[0]).toMatchObject({ forestCover: null, elevation: null, habitat: null });
  });
});

describe("toCovariateSpecs", () => {
  const raw = (over: Partial<{ f: number | null; e: number | null; h: string | null }>, id: string) => ({
    siteId: id,
    siteName: id,
    latitude: 0,
    longitude: 0,
    forestCover: over.f === undefined ? 0.5 : over.f,
    elevation: over.e === undefined ? 600 : over.e,
    habitat: over.h === undefined ? "bosque" : over.h,
  });

  it("emits forest, elevation, habitat in order when all sites have them", () => {
    const specs = toCovariateSpecs([raw({}, "a"), raw({}, "b")]);
    expect(specs.covariates.map((c) => c.name)).toEqual(["forest", "elevation", "habitat"]);
    expect(specs.covariates[2].kind).toBe("factor");
    expect(specs.dropped).toEqual([]);
  });

  it("drops a covariate missing on any site, with a reason", () => {
    const specs = toCovariateSpecs([raw({}, "a"), raw({ f: null }, "b")]);
    expect(specs.covariates.map((c) => c.name)).toEqual(["elevation", "habitat"]);
    expect(specs.dropped.map((d) => d.name)).toContain("forest");
    expect(specs.dropped[0].reason).toMatch(/1\/2/);
  });
});

describe("persistSiteCovariateSnapshot", () => {
  it("writes one row per site", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE occupancy_runs (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE occupancy_site_covariates (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, stream TEXT,
        site_id TEXT, site_name TEXT, latitude REAL, longitude REAL,
        habitat TEXT, elevation REAL, forest_cover REAL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.prepare("INSERT INTO occupancy_runs DEFAULT VALUES").run();
    persistSiteCovariateSnapshot(db, 1, "camera", [
      { siteId: "1", siteName: "S1", latitude: 0.4, longitude: -79.6, habitat: "bosque", elevation: 600, forestCover: 0.8 },
      { siteId: "2", siteName: "S2", latitude: 0.41, longitude: -79.61, habitat: "pasto", elevation: 400, forestCover: 0.2 },
    ]);
    const rows = db.prepare("SELECT * FROM occupancy_site_covariates ORDER BY site_id").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ run_id: 1, stream: "camera", forest_cover: 0.8 });
    db.close();
  });
});
