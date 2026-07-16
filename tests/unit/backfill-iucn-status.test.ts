/**
 * U5 — IUCN backfill `--only-missing` flag (query selection).
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  buildSpeciesQuery,
  extractCategoryCode,
  pickLatestAssessment,
} from "../../scripts/backfill-iucn-status.mjs";

describe("buildSpeciesQuery", () => {
  it("selects all species-rank, non-system rows by default", () => {
    const sql = buildSpeciesQuery(false);
    expect(sql).toContain("taxonomic_rank = 'species'");
    expect(sql).toContain("type != 'system'");
    expect(sql).not.toContain("iucn_status IS NULL");
  });

  it("restricts to unassessed rows with --only-missing", () => {
    const sql = buildSpeciesQuery(true);
    expect(sql).toContain("iucn_status IS NULL");
  });

  it("functionally excludes already-assessed rows when only-missing", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE biochoco_species (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scientific_name TEXT NOT NULL UNIQUE,
        common_name TEXT NOT NULL,
        taxonomic_rank TEXT NOT NULL DEFAULT 'species',
        type TEXT NOT NULL DEFAULT 'mammal',
        iucn_status TEXT
      );
      INSERT INTO biochoco_species (scientific_name, common_name, iucn_status) VALUES
        ('Panthera onca', 'Jaguar', 'NT'),
        ('Adelomyia melanogenys', 'Speckled Hummingbird', NULL),
        ('Homo sapiens', 'Human', NULL);
      UPDATE biochoco_species SET type = 'system' WHERE scientific_name = 'Homo sapiens';
    `);

    const nameOf = (r: unknown) => (r as { scientific_name: string }).scientific_name;
    const all = db.prepare(buildSpeciesQuery(false)).all().map(nameOf);
    expect(all).toEqual(["Adelomyia melanogenys", "Panthera onca"]); // system excluded, ordered

    const missing = db.prepare(buildSpeciesQuery(true)).all().map(nameOf);
    expect(missing).toEqual(["Adelomyia melanogenys"]); // NT already assessed → skipped
    db.close();
  });
});

describe("extractCategoryCode", () => {
  it("reads the flat red_list_category_code from a taxa summary assessment", () => {
    // This is the real v4 shape — the previous nested-only lookup missed it,
    // producing a uniform '(no assessment)' for every species.
    expect(
      extractCategoryCode({ assessment_id: 1, red_list_category_code: "LC" })
    ).toBe("LC");
  });

  it("falls back to a nested red_list_category.code", () => {
    expect(extractCategoryCode({ red_list_category: { code: "VU" } })).toBe("VU");
  });

  it("returns null for missing/empty/non-object input", () => {
    expect(extractCategoryCode(null)).toBeNull();
    expect(extractCategoryCode({})).toBeNull();
    expect(extractCategoryCode({ red_list_category_code: "" })).toBeNull();
  });
});

describe("pickLatestAssessment", () => {
  it("prefers the assessment flagged latest === true", () => {
    const a = pickLatestAssessment([
      { assessment_id: 1, year_published: "2005", latest: false },
      { assessment_id: 2, year_published: "1998", latest: true },
    ]);
    expect(a.assessment_id).toBe(2);
  });

  it("falls back to the newest year_published when none flagged", () => {
    const a = pickLatestAssessment([
      { assessment_id: 1, year_published: "2005" },
      { assessment_id: 2, year_published: "2021" },
    ]);
    expect(a.assessment_id).toBe(2);
  });

  it("returns null for empty/non-array input", () => {
    expect(pickLatestAssessment([])).toBeNull();
    expect(pickLatestAssessment(undefined)).toBeNull();
  });
});
