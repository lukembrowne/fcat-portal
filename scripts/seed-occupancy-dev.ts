/**
 * Seed synthetic, occupancy-structured dev data so the occupancy pipeline is
 * exercisable locally without production data.
 *
 * It CREATES deployments (with real AOI coordinates + survey windows), camera
 * images with filename-encoded capture dates, verified detections/identifications,
 * and the audio equivalents — with presence/absence driven by a KNOWN occupancy
 * process z ~ Bernoulli(plogis(b0 + b_forest·forest + b_elev·elev)) and detection
 * p, so tests can assert against the seeded truth and the /ocupacion page shows
 * eligible species.
 *
 * Forest cover + elevation are sampled from the REAL rasters (the Planet
 * land-cover raster + Copernicus DEM, via scripts/occupancy-forest-cover.py) so
 * the dev data exercises the exact production covariate path. This requires
 * OCCUPANCY_FOREST_RASTER + OCCUPANCY_DEM_RASTER and fails loudly if unset — pass
 * `--synthetic` (CLI) / `{ covariates: "synthetic" }` (unit tests) for a
 * rasterio-free deterministic fallback. Habitat stays synthetic (seeded sites
 * don't map to real ODK site codes). All three are stored on the deployment's
 * `field_notes` as an `occSeed` JSON blob so effects stay recoverable end-to-end.
 *
 * Idempotent + reversible: all rows hang off deployments named `OCC-SEED-*`;
 * re-running deletes them first (ON DELETE CASCADE clears images/detections/
 * identifications/audio). Remove entirely with `--clean`.
 *
 * Run INSIDE the container (never bare host while the dev container holds the DB
 * — macOS bind-mount corruption, see project memory):
 *   docker compose exec -T portal npx tsx scripts/seed-occupancy-dev.ts
 *   docker compose exec -T portal npx tsx scripts/seed-occupancy-dev.ts --clean
 */
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import path from "path";

export const SEED_PREFIX = "OCC-SEED-";
const AUDIO_CONF_HIGH = 0.85; // above the 0.7 default threshold
const AUDIO_CONF_LOW = 0.4; // below threshold — noise, excluded by readiness

// Uniform survey window for every seed site → identical 5-day occasion bins →
// the survey-effort detection covariate is a single level and gets dropped, so
// the demo detection submodel is a clean intercept-only fit (no effort-level
// separation to blow up the detection CIs).
const WIN_LEN_DAYS = 40;
const N_OCCASIONS = 8; // 40 / 5-day bins

// AOI bounding box (FCAT / Planet AOI), roughly matching real deployment coords.
const AOI = { latMin: 0.36, latMax: 0.42, lngMin: -79.68, lngMax: -79.62 };

interface SpeciesSpec {
  name: string;
  b0: number;
  bForest: number;
  bElev: number;
  p: number; // per-occasion detection probability
}

// Synthetic demo species. Named with obviously-fictional genera (Simulamys /
// Simulavis) so they DON'T collide with any real dev species — the occupancy
// models fit over the seed sites alone (real deployments carry the real species
// names), keeping each demo model a clean ~forest+elevation fit whose seeded
// relationship survives into the response curves. Epithets encode the expected
// response: -icola/-cola = habitat affinity, montana/planicola = elevation.
// Coefficients are strong (|b|≈2) with b0≈0 so ψ spans ~2%→98% across the AOI
// gradient — the slope is unmistakable — while staying short of full saturation.
const CAMERA_SPECIES: SpeciesSpec[] = [
  { name: "Simulamys silvicola", b0: 0.0, bForest: 2.0, bElev: 0.0, p: 0.55 }, // forest+
  { name: "Simulamys campicola", b0: 0.0, bForest: -2.0, bElev: 0.0, p: 0.55 }, // forest− (open)
  { name: "Simulamys montana", b0: 0.6, bForest: 0.0, bElev: 2.2, p: 0.55 }, // elevation+
  { name: "Simulamys planicola", b0: 0.0, bForest: 0.0, bElev: -2.2, p: 0.55 }, // elevation−
  { name: "Simulamys sylvomontana", b0: -0.4, bForest: 1.4, bElev: 1.4, p: 0.5 }, // forest+ & elev+
  { name: "Simulamys communis", b0: 0.3, bForest: 0.3, bElev: -0.2, p: 0.6 }, // near-neutral control
];

const AUDIO_SPECIES: SpeciesSpec[] = [
  { name: "Simulavis silvicola", b0: 0.0, bForest: 2.0, bElev: 0.1, p: 0.6 }, // forest+
  { name: "Simulavis campicola", b0: 0.0, bForest: -2.0, bElev: 0.0, p: 0.6 }, // forest−
  { name: "Simulavis montana", b0: 0.6, bForest: 0.1, bElev: 2.2, p: 0.6 }, // elevation+
  { name: "Simulavis planicola", b0: 0.0, bForest: 0.0, bElev: -2.2, p: 0.6 }, // elevation−
  { name: "Simulavis sylvomontana", b0: -0.4, bForest: 1.4, bElev: 1.2, p: 0.55 }, // forest+ & elev+
  { name: "Simulavis communis", b0: 0.3, bForest: 0.3, bElev: -0.2, p: 0.62 }, // near-neutral control
];

/** Deterministic PRNG (mulberry32) so seeding is reproducible. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const plogis = (x: number) => 1 / (1 + Math.exp(-x));
const ymd = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

export interface SeedOptions {
  nSites?: number;
  seed?: number;
  /** project_id for the deployments (must exist in projects). */
  projectId?: string;
  /**
   * Covariate source for forest cover + elevation:
   *   - "raster" (default): sample the REAL rasters via the Python pipeline.
   *     Hard-requires OCCUPANCY_FOREST_RASTER + OCCUPANCY_DEM_RASTER — throws if
   *     unset or if any site samples to null (nodata). No synthetic fallback, so
   *     a misconfigured environment fails loudly instead of seeding fake data.
   *   - "synthetic": a deterministic forest gradient + elevation, no rasterio.
   *     Explicit opt-in for unit tests only (keeps them hermetic).
   */
  covariates?: "raster" | "synthetic";
}

interface SampledCovariate {
  forest: number;
  elevation: number;
}

/**
 * Sample real forest cover + elevation for every site in ONE call to
 * scripts/occupancy-forest-cover.py (no AOI grid — per-site only). Throws with a
 * clear message if the rasters aren't configured, the script fails, or any site
 * samples to null — the seeder must never silently fall back to synthetic data.
 */
function sampleCovariatesFromRaster(
  sites: { siteId: string; lat: number; lng: number }[],
): Map<string, SampledCovariate> {
  const forestRaster = process.env.OCCUPANCY_FOREST_RASTER;
  const demRaster = process.env.OCCUPANCY_DEM_RASTER;
  if (!forestRaster) {
    throw new Error(
      "OCCUPANCY_FOREST_RASTER is not set — raster seeding requires the forest-cover raster (or pass { covariates: 'synthetic' }).",
    );
  }
  if (!demRaster) {
    throw new Error(
      "OCCUPANCY_DEM_RASTER is not set — raster seeding requires the elevation DEM (or pass { covariates: 'synthetic' }).",
    );
  }
  const python =
    process.env.OCCUPANCY_PYTHON_PATH ||
    process.env.ML_PYTHON_PATH ||
    path.join(process.cwd(), "data", "ml-venv", "bin", "python3");
  const script = path.join(process.cwd(), "scripts", "occupancy-forest-cover.py");
  const forestClasses = (process.env.OCCUPANCY_FOREST_CLASSES ?? "1")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  const config = {
    forestRaster,
    demRaster,
    forestClasses,
    bufferMeters: process.env.OCCUPANCY_BUFFER_METERS
      ? Number(process.env.OCCUPANCY_BUFFER_METERS)
      : 500,
    sites,
  };

  const res = spawnSync(python, [script], {
    input: JSON.stringify(config),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  if (res.error) {
    throw new Error(`forest-cover script failed to spawn (${python}): ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `forest-cover script exited ${res.status}: ${(res.stderr || "").slice(-500)}`,
    );
  }

  const out = new Map<string, SampledCovariate>();
  let scriptError: string | null = null;
  for (const line of (res.stdout || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(t);
    } catch {
      continue;
    }
    if (msg.type === "error") scriptError = String(msg.message ?? "unknown error");
    else if (msg.type === "sites") {
      for (const s of msg.sites as { siteId: string; forestCover: number | null; elevation: number | null }[]) {
        if (s.forestCover == null || s.elevation == null) {
          throw new Error(
            `site ${s.siteId} sampled to null (forest=${s.forestCover}, elevation=${s.elevation}) — coordinate likely outside raster/DEM coverage.`,
          );
        }
        out.set(s.siteId, { forest: s.forestCover, elevation: s.elevation });
      }
    }
  }
  if (scriptError) throw new Error(`forest-cover script error: ${scriptError}`);
  if (out.size !== sites.length) {
    throw new Error(
      `forest-cover returned ${out.size} sites, expected ${sites.length}.`,
    );
  }
  return out;
}

export interface SeedResult {
  sites: number;
  cameraDetections: number;
  audioDetections: number;
  cameraSpecies: number;
  audioSpecies: number;
}

/** Delete every seed deployment (cascades to all dependent rows). */
export function cleanOccupancySeed(db: Database.Database): number {
  const res = db
    .prepare(`DELETE FROM biochoco_deployments WHERE name LIKE '${SEED_PREFIX}%'`)
    .run();
  return res.changes;
}

export function seedOccupancyDev(
  db: Database.Database,
  opts: SeedOptions = {},
): SeedResult {
  const nSites = opts.nSites ?? 40;
  const rng = makeRng(opts.seed ?? 20260706);

  // Resolve a valid project_id (deployments.project_id is NOT NULL FK).
  const projectId =
    opts.projectId ??
    (db
      .prepare(
        "SELECT project_id AS p FROM biochoco_deployments WHERE project_id IS NOT NULL LIMIT 1",
      )
      .get() as { p?: string } | undefined)?.p ??
    "camera-trap";

  // The occupancy pool is scoped to the BioChoco ct project, so seeded
  // deployments must belong to it (INSERT OR IGNORE keeps an existing row).
  db.prepare("INSERT OR IGNORE INTO ct_projects (name) VALUES ('BioChoco')").run();
  const ctProjectId = (
    db.prepare("SELECT id FROM ct_projects WHERE name = 'BioChoco'").get() as { id: number }
  ).id;

  cleanOccupancySeed(db);

  const insDep = db.prepare(
    `INSERT INTO biochoco_deployments
       (project_id, ct_project_id, name, site_name, latitude, longitude, date_start, date_end,
        status, excluded, field_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', 0, ?)`,
  );
  const insImg = db.prepare(
    `INSERT INTO biochoco_images (deployment_id, filename, status)
     VALUES (?, ?, 'processed')`,
  );
  const insDet = db.prepare(
    `INSERT INTO biochoco_detections
       (image_id, bbox_x, bbox_y, bbox_width, bbox_height, detection_confidence, detection_class, model_version)
     VALUES (?, 0.3, 0.3, 0.4, 0.4, 0.95, 0, 'OCC-SEED')`,
  );
  const insIdent = db.prepare(
    `INSERT INTO biochoco_identifications
       (detection_id, species, confidence, model_version, verification_status, verified_by, verified_at)
     VALUES (?, ?, 0.9, 'OCC-SEED', 'verified', 'occ-seed@fcat-ecuador.org', ?)`,
  );
  const insAudioFile = db.prepare(
    `INSERT INTO audio_files (deployment_id, filename, format) VALUES (?, ?, 'wav')`,
  );
  const insAudioDet = db.prepare(
    `INSERT INTO audio_detections
       (audio_file_id, start_time, end_time, min_freq, max_freq, confidence, model_version)
     VALUES (?, 0, 3, 500, 8000, ?, 'OCC-SEED')`,
  );
  const insAudioIdent = db.prepare(
    `INSERT INTO audio_identifications
       (audio_detection_id, species, confidence, model_version, verification_status)
     VALUES (?, ?, ?, 'OCC-SEED', 'unverified')`,
  );

  const nowSec = 1751800000; // fixed epoch seconds (deterministic; ~2025-07)
  const baseDate = new Date(Date.UTC(2026, 0, 5));

  const result: SeedResult = {
    sites: 0,
    cameraDetections: 0,
    audioDetections: 0,
    cameraSpecies: CAMERA_SPECIES.length,
    audioSpecies: AUDIO_SPECIES.length,
  };

  const ymdDash = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate(),
    ).padStart(2, "0")}`;

  // Insert one seed deployment + its camera/audio detections. `forest`/`elevation`
  // are the site's covariates (real raster samples or synthetic); the occupancy
  // process draws presence/detection from `rng` in a fixed order so a given seed
  // + covariate set is fully reproducible.
  const emitSite = (
    i: number,
    lat: number,
    lng: number,
    winStart: Date,
    winLen: number,
    nOccasions: number,
    forest: number,
    elevation: number,
  ) => {
    const forestZ = (forest - 0.5) / 0.25;
    const elevZ = (elevation - 650) / 260;
    const winEnd = addDays(winStart, winLen - 1);

    // NOTE: deliberately NO habitat covariate on seed sites. A forest-derived
    // habitat bin is collinear with the forest covariate and would steal its
    // slope in the fit; the demo cohort is a clean ~forest+elevation model, and
    // the habitat-factor path is exercised by the real deployments instead.
    const fieldNotes = JSON.stringify({
      occSeed: { forest: Number(forest.toFixed(4)), elevation: Math.round(elevation) },
    });
    const depId = Number(
      insDep.run(
        projectId,
        ctProjectId,
        `${SEED_PREFIX}${String(i).padStart(3, "0")}`,
        `Sitio sintético ${i}`,
        lat,
        lng,
        ymdDash(winStart),
        ymdDash(winEnd),
        fieldNotes,
      ).lastInsertRowid,
    );
    result.sites++;

    let imgSeq = 0;
    // Camera detections.
    for (const sp of CAMERA_SPECIES) {
      const psi = plogis(sp.b0 + sp.bForest * forestZ + sp.bElev * elevZ);
      const occupied = rng() < psi;
      if (!occupied) continue;
      for (let j = 0; j < nOccasions; j++) {
        if (rng() >= sp.p) continue; // not detected this occasion
        const dayOffset = j * 5 + Math.floor(rng() * 5);
        if (dayOffset >= winLen) continue;
        const capDay = addDays(winStart, dayOffset);
        const fn = `${SEED_PREFIX}${i} - ${ymd(capDay)} - IMG${String(imgSeq++).padStart(4, "0")}.JPG`;
        const imgId = Number(insImg.run(depId, fn).lastInsertRowid);
        const detId = Number(insDet.run(imgId).lastInsertRowid);
        insIdent.run(detId, sp.name, nowSec);
        result.cameraDetections++;
      }
    }

    // Audio detections (unverified, confidence-filtered).
    for (const sp of AUDIO_SPECIES) {
      const psi = plogis(sp.b0 + sp.bForest * forestZ + sp.bElev * elevZ);
      const occupied = rng() < psi;
      for (let j = 0; j < nOccasions; j++) {
        const dayOffset = j * 5 + Math.floor(rng() * 5);
        if (dayOffset >= winLen) continue;
        const capDay = addDays(winStart, dayOffset);
        const hh = String(5 + Math.floor(rng() * 3)).padStart(2, "0");
        const fn = `OCCSEED${i}_${ymd(capDay)}_${hh}0000.wav`;
        const detected = occupied && rng() < sp.p;
        // Emit an above-threshold detection where truly detected; otherwise a
        // sprinkling of below-threshold "noise" so the confidence filter matters.
        if (!detected && rng() > 0.15) continue;
        const afId = Number(insAudioFile.run(depId, fn).lastInsertRowid);
        const adId = Number(
          insAudioDet.run(afId, detected ? AUDIO_CONF_HIGH : AUDIO_CONF_LOW).lastInsertRowid,
        );
        insAudioIdent.run(adId, sp.name, detected ? AUDIO_CONF_HIGH : AUDIO_CONF_LOW);
        if (detected) result.audioDetections++;
      }
    }
  };

  const source = opts.covariates ?? "raster";

  if (source === "synthetic") {
    // Hermetic path (unit tests): synthetic forest gradient + elevation, drawn
    // inline so the rng sequence — and thus the whole realization — is stable.
    const tx = db.transaction(() => {
      for (let i = 0; i < nSites; i++) {
        const forest = Math.max(0, Math.min(1, 0.15 + 0.75 * (i / (nSites - 1)) + (rng() - 0.5) * 0.2));
        const elevation = 200 + 900 * rng(); // meters, 200–1100
        const lat = AOI.latMin + (AOI.latMax - AOI.latMin) * rng();
        const lng = AOI.lngMin + (AOI.lngMax - AOI.lngMin) * rng();
        const winStart = addDays(baseDate, Math.floor(rng() * 20));
        emitSite(i, lat, lng, winStart, WIN_LEN_DAYS, N_OCCASIONS, forest, elevation);
      }
    });
    tx();
    return result;
  }

  // Raster path (default): draw all site geometry first, batch-sample the REAL
  // rasters for forest cover + elevation (throws if unconfigured or any site is
  // nodata — no synthetic fallback), then insert + simulate detections. One
  // continuous rng stream (geometry for all sites, then detections for all
  // sites) keeps a given seed + raster set reproducible.
  const geom = Array.from({ length: nSites }, (_, i) => {
    const lat = AOI.latMin + (AOI.latMax - AOI.latMin) * rng();
    const lng = AOI.lngMin + (AOI.lngMax - AOI.lngMin) * rng();
    const winStart = addDays(baseDate, Math.floor(rng() * 20));
    return { i, lat, lng, winStart, winLen: WIN_LEN_DAYS, nOccasions: N_OCCASIONS };
  });

  const samples = sampleCovariatesFromRaster(
    geom.map((g) => ({ siteId: String(g.i), lat: g.lat, lng: g.lng })),
  );

  const tx = db.transaction(() => {
    for (const g of geom) {
      const cov = samples.get(String(g.i))!;
      emitSite(g.i, g.lat, g.lng, g.winStart, g.winLen, g.nOccasions, cov.forest, cov.elevation);
    }
  });
  tx();
  return result;
}

/** Read the seeded latent covariates for a deployment, if present. */
export function readSeedCovariates(
  fieldNotes: string | null | undefined,
): { forest: number; elevation: number; habitat?: string } | null {
  if (!fieldNotes) return null;
  try {
    const parsed = JSON.parse(fieldNotes);
    return parsed?.occSeed ?? null;
  } catch {
    return null;
  }
}

// --- CLI ---
function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.includes("seed-occupancy-dev");
}

if (isMain()) {
  const dbPath = process.env.DB_PATH || "data/portal.db";
  const full = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
  const db = new Database(full);
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  if (process.argv.includes("--clean")) {
    const n = cleanOccupancySeed(db);
    console.log(`[occ-seed] removed ${n} seed deployments (cascaded).`);
    db.close();
    process.exit(0);
  }
  // Default: sample the REAL rasters (fails loudly if OCCUPANCY_FOREST_RASTER /
  // OCCUPANCY_DEM_RASTER aren't set). Pass --synthetic to seed without rasterio.
  const covariates = process.argv.includes("--synthetic") ? "synthetic" : "raster";
  console.log(`[occ-seed] covariate source: ${covariates}`);
  const res = seedOccupancyDev(db, { covariates });
  console.log(
    `[occ-seed] seeded ${res.sites} sites | camera: ${res.cameraDetections} dets / ${res.cameraSpecies} species | audio: ${res.audioDetections} dets / ${res.audioSpecies} species`,
  );
  db.close();
}
