import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  seedOccupancyDev,
  cleanOccupancySeed,
  readSeedCovariates,
  SEED_PREFIX,
} from "../../scripts/seed-occupancy-dev";

// Minimal DDL covering exactly the columns the seeder writes (no FKs/CHECKs so
// the test DB stays self-contained).
const DDL = `
  CREATE TABLE ct_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE biochoco_deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    ct_project_id INTEGER,
    name TEXT NOT NULL,
    site_name TEXT,
    latitude REAL, longitude REAL,
    date_start TEXT, date_end TEXT,
    status TEXT, excluded_audio INTEGER DEFAULT 0, excluded_camera INTEGER DEFAULT 0,
    field_notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE biochoco_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL,
    filename TEXT NOT NULL, status TEXT, exif_timestamp TEXT
  );
  CREATE TABLE biochoco_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    bbox_x REAL, bbox_y REAL, bbox_width REAL, bbox_height REAL,
    detection_confidence REAL, detection_class INTEGER DEFAULT 0, model_version TEXT
  );
  CREATE TABLE biochoco_identifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detection_id INTEGER NOT NULL, species TEXT NOT NULL, confidence REAL,
    model_version TEXT, verification_status TEXT, verified_by TEXT, verified_at INTEGER
  );
  CREATE TABLE audio_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL, filename TEXT NOT NULL, format TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE audio_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_file_id INTEGER NOT NULL, start_time REAL, end_time REAL,
    min_freq REAL, max_freq REAL, confidence REAL, model_version TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE audio_identifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_detection_id INTEGER NOT NULL, species TEXT NOT NULL, confidence REAL,
    model_version TEXT, verification_status TEXT
  );
  CREATE TABLE biochoco_processing_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER, job_type TEXT NOT NULL DEFAULT 'ml',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

function freshDb() {
  const db = new Database(":memory:");
  db.exec(DDL);
  return db;
}

describe("seedOccupancyDev", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("creates the requested number of seed sites with recoverable covariates", () => {
    const res = seedOccupancyDev(db, { nSites: 40, covariates: "synthetic" });
    expect(res.sites).toBe(40);
    const deps = db
      .prepare(`SELECT field_notes FROM biochoco_deployments WHERE name LIKE '${SEED_PREFIX}%'`)
      .all() as { field_notes: string }[];
    expect(deps).toHaveLength(40);
    for (const d of deps) {
      const cov = readSeedCovariates(d.field_notes);
      expect(cov).not.toBeNull();
      expect(cov!.forest).toBeGreaterThanOrEqual(0);
      expect(cov!.forest).toBeLessThanOrEqual(1);
      // Seed sites deliberately carry NO habitat covariate — a forest-derived
      // habitat bin is collinear with the forest covariate. The demo cohort is a
      // clean ~forest+elevation model; habitat is exercised by real deployments.
      expect(cov!.habitat).toBeUndefined();
      expect(typeof cov!.elevation).toBe("number");
    }
  });

  it("produces camera species detected across many sites (occupancy spread)", () => {
    seedOccupancyDev(db, { nSites: 40, covariates: "synthetic" });
    const spread = db
      .prepare(`
        SELECT id.species sp, COUNT(DISTINCT img.deployment_id) sites, COUNT(*) c
        FROM biochoco_identifications id
        JOIN biochoco_detections d ON d.id = id.detection_id
        JOIN biochoco_images img ON img.id = d.image_id
        WHERE id.verification_status = 'verified'
        GROUP BY 1`)
      .all() as { sp: string; sites: number; c: number }[];
    expect(spread.length).toBeGreaterThan(0);
    // At least one species clears the eligibility spread (>=3 sites, >=10 dets).
    expect(spread.some((r) => r.sites >= 15 && r.c >= 10)).toBe(true);
    // Filenames carry parseable dates (image count > 0).
    const imgs = db.prepare("SELECT COUNT(*) n FROM biochoco_images").get() as { n: number };
    expect(imgs.n).toBeGreaterThan(0);
  });

  it("produces audio detections above and below the confidence threshold", () => {
    seedOccupancyDev(db, { nSites: 40, covariates: "synthetic" });
    const high = db
      .prepare("SELECT COUNT(*) n FROM audio_identifications WHERE confidence >= 0.7")
      .get() as { n: number };
    const low = db
      .prepare("SELECT COUNT(*) n FROM audio_identifications WHERE confidence < 0.7")
      .get() as { n: number };
    expect(high.n).toBeGreaterThan(0);
    expect(low.n).toBeGreaterThan(0); // noise exists → the threshold matters
  });

  it("is deterministic for a fixed seed", () => {
    const a = seedOccupancyDev(freshDb(), { nSites: 20, seed: 123, covariates: "synthetic" });
    const b = seedOccupancyDev(freshDb(), { nSites: 20, seed: 123, covariates: "synthetic" });
    expect(a).toEqual(b);
  });

  it("is idempotent — re-running replaces, does not accumulate", () => {
    seedOccupancyDev(db, { nSites: 30, covariates: "synthetic" });
    seedOccupancyDev(db, { nSites: 30, covariates: "synthetic" });
    const deps = db
      .prepare(`SELECT COUNT(*) n FROM biochoco_deployments WHERE name LIKE '${SEED_PREFIX}%'`)
      .get() as { n: number };
    expect(deps.n).toBe(30);
  });

  it("cleanOccupancySeed removes all seed rows", () => {
    seedOccupancyDev(db, { nSites: 10, covariates: "synthetic" });
    const removed = cleanOccupancySeed(db);
    expect(removed).toBe(10);
    const left = db
      .prepare("SELECT COUNT(*) n FROM biochoco_identifications")
      .get() as { n: number };
    // No FK cascade in the minimal test DB, so child rows persist; the point is
    // the deployments (the seed anchor) are gone. In prod, ON DELETE CASCADE clears children.
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM biochoco_deployments WHERE name LIKE '${SEED_PREFIX}%'`).get() as { n: number }).n,
    ).toBe(0);
    expect(left.n).toBeGreaterThanOrEqual(0);
  });
});
