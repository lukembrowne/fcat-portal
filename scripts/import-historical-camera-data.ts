/**
 * Import historical camera trap data from 2014 CSVs.
 *
 * Enriches deployments with coordinates/dates from Camera_log,
 * and pre-fills species identifications from species detection data.
 *
 * Run AFTER Drive sync + MegaDetector processing.
 *
 * Usage:
 *   npx tsx scripts/import-historical-camera-data.ts [--dry-run] [--deployment TP-062] [--yes]
 */

import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import {
  mkdirSync,
  readFileSync,
  readSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import path from "path";
import proj4 from "proj4";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CSV_DIR = path.join(process.cwd(), "data", "historical-camera-data");

const CAMERA_LOG_FILE = "Camera_log 2015_01_12.csv";
const SPECIES_DETECTION_FILE = "species detection data 2020_03_17(in).csv";

const utm17n = "+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs";
const wgs84 = "+proj=longlat +datum=WGS84 +no_defs";

// ---------------------------------------------------------------------------
// Timestamped logging
// ---------------------------------------------------------------------------

const RUN_TIMESTAMP = new Date()
  .toISOString()
  .replace(/:/g, "-")
  .replace(/\.\d+Z$/, "");

const LOG_DIR = path.join(CSV_DIR, "logs");
mkdirSync(LOG_DIR, { recursive: true });

let LOG_FILE: string; // set after CLI flags are parsed

/** Tee-style logger: writes to both console and a log file */
function log(msg: string = "") {
  console.log(msg);
  appendFileSync(LOG_FILE, msg + "\n");
}

/** Format a list of items as comma-separated, wrapping at ~maxWidth chars */
function formatCompactList(items: string[], indent: string, maxWidth = 100): string {
  if (items.length === 0) return "";
  const lines: string[] = [];
  let current = indent;
  for (let i = 0; i < items.length; i++) {
    const sep = i === 0 ? "" : ", ";
    const next = sep + items[i];
    if (current.length + next.length > maxWidth && current !== indent) {
      lines.push(current);
      current = indent + items[i];
    } else {
      current += next;
    }
  }
  if (current !== indent) lines.push(current);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Filename prefix extraction
// ---------------------------------------------------------------------------

/**
 * Extract the camera file ID from a filename.
 *
 * Examples:
 *   "IMG_0019 bird obs one.AVI"       → "img_0019"
 *   "IMG_0005 (2) agouti one.AVI"     → "img_0005 (2)"
 *   "IMG_0064 paca one (2).AVI"       → "img_0064 (2)"
 *   "IMG_0019.AVI"                    → "img_0019"
 *   "MVI_0003 bird one.AVI"           → "mvi_0003"
 */
function extractFilePrefix(filename: string): string {
  // Remove extension
  const noExt = filename.replace(/\.\w+$/, "").trim();

  // Extract the first alphanumeric+underscore token (e.g. IMG_0019, MVI_0003)
  const baseMatch = noExt.match(/^[\w]+/);
  const base = baseMatch ? baseMatch[0].toLowerCase() : noExt.toLowerCase();

  // Extract any (N) disambiguator found anywhere in the name
  const disambigMatch = noExt.match(/\(\d+\)/);
  const disambig = disambigMatch ? " " + disambigMatch[0] : "";

  return base + disambig;
}

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipPrompt = args.includes("--yes") || args.includes("-y");
const deploymentFilterIdx = args.indexOf("--deployment");
const deploymentFilter =
  deploymentFilterIdx !== -1 ? args[deploymentFilterIdx + 1] : null;

const runMode = dryRun ? "dry-run" : "live";
LOG_FILE = path.join(LOG_DIR, `import-${runMode}-${RUN_TIMESTAMP}.log`);
writeFileSync(LOG_FILE, ""); // create/truncate

if (dryRun) log("*** DRY RUN — no changes will be written ***\n");
if (deploymentFilter)
  log(`Filtering to deployment: ${deploymentFilter}\n`);

if (!dryRun) {
  log(
    "WARNING: This will modify the database. Make sure you have a backup!\n" +
      "  Run: node scripts/backup-db.mjs\n" +
      "  Or use --dry-run to preview changes first.\n"
  );
  if (!skipPrompt) {
    process.stdout.write("Proceed? (y/N): ");
    const buf = Buffer.alloc(1024);
    const bytesRead = readSync(0, buf);
    const answer = buf.toString("utf8", 0, bytesRead).trim();
    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.");
      process.exit(0);
    }
    log(""); // blank line after prompt
  }
}

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------

const dbPath = process.env.DB_PATH || "data/portal.db";
const fullDbPath = path.isAbsolute(dbPath)
  ? dbPath
  : path.join(process.cwd(), dbPath);

const db = new Database(fullDbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// ---------------------------------------------------------------------------
// CSV parsing helpers
// ---------------------------------------------------------------------------

function loadCSV(filename: string): Record<string, string>[] {
  const raw = readFileSync(path.join(CSV_DIR, filename), "utf-8");
  // Strip BOM if present
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return parse(clean, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
}

/** Normalize dates like "8-Jul-13", "8/3/2014", "8/7/14 17:43" → ISO 8601 */
function normalizeDate(raw: string): string | null {
  if (!raw || raw.trim() === "") return null;
  const s = raw.trim();

  // "8-Jul-13" or "14-Jul-13"
  const dmy = s.match(/^(\d{1,2})-(\w{3})-(\d{2})$/);
  if (dmy) {
    const months: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04",
      May: "05", Jun: "06", Jul: "07", Aug: "08",
      Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    };
    const day = dmy[1].padStart(2, "0");
    const mon = months[dmy[2]];
    const year = parseInt(dmy[3]) < 50 ? `20${dmy[3]}` : `19${dmy[3]}`;
    if (mon) return `${year}-${mon}-${day}`;
  }

  // "8/3/2014" or "8/7/14" or "8/7/14 17:43"
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (mdy) {
    const mon = mdy[1].padStart(2, "0");
    const day = mdy[2].padStart(2, "0");
    let year = mdy[3];
    if (year.length === 2) {
      year = parseInt(year) < 50 ? `20${year}` : `19${year}`;
    }
    return `${year}-${mon}-${day}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeploymentMeta = {
  easting: number | null;
  northing: number | null;
  datePlaced: string | null;
  dateRemoved: string | null;
};

type CsvDetection = {
  filename: string;
  species: string;
  count: number;
  date: string | null;
};

interface DbDeployment {
  id: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  date_start: string | null;
  date_end: string | null;
}

interface DbDetectionRow {
  video_id: number;
  video_filename: string;
  image_id: number;
  detection_id: number;
  detection_confidence: number;
  ident_id: number;
  ml_species: string;
  verification_status: string;
}

interface DbVideoRow {
  id: number;
  filename: string;
}

// ---------------------------------------------------------------------------
// Species name normalization
// ---------------------------------------------------------------------------

/**
 * Maps CSV species strings to canonical scientific_name values from biochoco_species.
 *
 * Three categories:
 * - Parenthetical extraction: "common name (Scientific name)" → extract scientific name
 * - Common name → scientific name lookups
 * - Synonyms/reclassifications/typos → corrected DB name
 *
 * Mammal scientific names (Dasyprocta punctata, etc.) pass through unchanged.
 */
const SPECIES_NAME_MAP = new Map<string, string>([
  // Parenthetical extraction (lowercase CSV variants)
  ["buff-throated foliage-gleaner (Automolus ochrolaemus)", "Automolus ochrolaemus"],
  ["orange billed sparrow (Arremon aurantiirostris)", "Arremon aurantiirostris"],
  ["rufous fronted wood-quail (Odontophorus erythrops)", "Odontophorus erythrops"],
  ["song wren (Cyphorhinus phaeocephalus)", "Cyphorhinus phaeocephalus"],
  ["wedge-billed woodcreeper (Glyphorynchus spirurus)", "Glyphorynchus spirurus"],
  ["spotted antbird (Hylophylax naevioides)", "Hylophylax naevioides"],
  ["rufous-headed chachalaca (Ortalis erythroptera)", "Ortalis erythroptera"],
  ["ecuadorian thrush (Turdus maculirostris)", "Turdus maculirostris"],
  ["plain-brown woodcreeper (Dendrocincla fuliginosa)", "Dendrocincla fuliginosa"],
  ["streak-chested antpitta (Hylopezus perspicillatus)", "Hylopezus perspicillatus"],
  ["great tinamou (Tinamus major)", "Tinamus major"],
  ["little tinamou (Crypturellus soui)", "Crypturellus soui"],
  ["tawny-faced quail (Rhynchortyx cinctus)", "Rhynchortyx cinctus"],
  ["olive-backed quail-dove (Geotrygon veraguensis)", "Geotrygon veraguensis"],
  ["ruddy quail dove (Geotrygon montana)", "Geotrygon montana"],
  ["scaly-breasted wren (Microcerculus marginatus)", "Microcerculus marginatus"],
  ["pallid/white-tipped dove (Leptotila sp.)", "Leptotila sp."],
  ["lesser tinamou (Crypturellus soui)", "Crypturellus soui"],
  ["buff-rumped warbler (Myiothlypis fulvicauda)", "Myiothlypis fulvicauda"],
  ["brown wood rail (Aramides wolfi)", "Aramides wolfi"],
  ["indigo crowned quail-dove (Geotrygon purpurata)", "Geotrygon purpurata"],
  ["spotted nightinggale thrush (Catharus dryas)", "Catharus dryas"],

  // Parenthetical extraction (Title Case CSV variants)
  ["plain brown woodcreeper (Dendrocincla fuliginosa)", "Dendrocincla fuliginosa"],
  ["Ecuadorian Thrush (Turdus maculirostris)", "Turdus maculirostris"],
  ["Rufous-headed Chachalaca (Ortalis erythroptera)", "Ortalis erythroptera"],
  ["Berlepsch's Tinamou (Crypturellus berlepschi)", "Crypturellus berlepschi"],
  ["Scaled Antpitta (Grallaria guatimalensis)", "Grallaria guatimalensis"],
  ["Song Wren (Cyphorhinus phaeocephalus)", "Cyphorhinus phaeocephalus"],
  ["Spotted Antbird (Hylophylax naevioides)", "Hylophylax naevioides"],

  // Common name → scientific name
  ["barred forest-falcon", "Micrastur ruficollis"],
  ["bay wren", "Cantorchilus nigricapillus"],
  ["rufous motmot", "Baryphthengus martii"],
  ["leaftosser", "Sclerurus sp."],
  ["scaly", "Sclerurus sp."],
  ["white whiskered puffbird", "Malacoptila panamensis"],

  // Synonyms/reclassifications/typos
  ["Puma yagouaroundi", "Herpailurus yagouaroundi"],
  ["chestnut-backed antbird (Myrmeciza exsul)", "Poliocrania exsul"],
  ["black headed antthrush (Formacarius nigricapillus)", "Formicarius nigricapillus"],
  ["immaculate antbird (Myrmeciza immaculata?)", "Myrmeciza immaculata"],
]);

/** Resolve a CSV species string to its canonical DB scientific_name */
function resolveSpecies(csvSpecies: string): string {
  return SPECIES_NAME_MAP.get(csvSpecies) ?? csvSpecies;
}

/**
 * Ordered keyword→species tuples for inferring species from filenames.
 * Array (not Map) because match order matters — "spiny-rat" must be checked
 * before "rat" to avoid partial matches.
 */
const FILENAME_SPECIES_MAP: Array<[keyword: string, species: string]> = [
  ["spiny-rat", "Proechimys decumanus"],
  ["rat", "Proechimys decumanus"],
];

/**
 * Attempt to resolve a species from a video filename.
 * Strips extension, lowercases, checks each keyword using word-boundary-aware
 * regex ([\s\-] delimiters or start/end) to prevent false positives like
 * "rat" matching inside "crater".
 *
 * Returns the scientific name or null if no keyword matches.
 */
function resolveSpeciesFromFilename(filename: string): string | null {
  const normalized = filename.replace(/\.\w+$/, "").toLowerCase();
  for (const [keyword, species] of FILENAME_SPECIES_MAP) {
    // Match keyword at word boundaries defined by whitespace or hyphens
    const pattern = new RegExp(`(?:^|[\\s\\-])${keyword}(?:$|[\\s\\-])`, "i");
    if (pattern.test(normalized)) return species;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 1: Parse CSVs + build maps
// ---------------------------------------------------------------------------

log("Phase 1: Parsing CSVs...\n");

const cameraLogRows = loadCSV(CAMERA_LOG_FILE);
const speciesDetectionRows = loadCSV(SPECIES_DETECTION_FILE);

log(`  Camera_log: ${cameraLogRows.length} rows`);
log(`  Species detection data: ${speciesDetectionRows.length} rows`);

// Deployment metadata from Camera_log
const deploymentMetaMap = new Map<string, DeploymentMeta>();
for (const row of cameraLogRows) {
  const tp = row["Trapping_period"]?.trim();
  if (!tp) continue;
  if (deploymentFilter && tp !== deploymentFilter) continue;

  const easting = row["UTM1"] ? parseFloat(row["UTM1"]) : null;
  const northing = row["UTM2"] ? parseFloat(row["UTM2"]) : null;
  const datePlaced = normalizeDate(row["Date_placed"] || "");
  const dateRemoved = normalizeDate(row["Date_removed"] || "");

  if (!deploymentMetaMap.has(tp)) {
    deploymentMetaMap.set(tp, { easting, northing, datePlaced, dateRemoved });
  }
}

log(`  Deployment metadata entries: ${deploymentMetaMap.size}`);

// Detection data from species detection CSV
const detectionsByTP = new Map<string, CsvDetection[]>();

for (const row of speciesDetectionRows) {
  const tp = row["trapping_period"]?.trim();
  if (!tp) continue;
  if (deploymentFilter && tp !== deploymentFilter) continue;

  const filename = row["file_name"]?.trim();
  const rawSpecies = row["species"]?.trim();
  const countStr = row["n_animals"]?.trim();
  const count = countStr ? parseInt(countStr) : 1;
  const date = normalizeDate(row["date_video"] || "");

  if (!filename || !rawSpecies) continue;

  const species = resolveSpecies(rawSpecies);
  if (!detectionsByTP.has(tp)) detectionsByTP.set(tp, []);
  detectionsByTP.get(tp)!.push({ filename, species, count, date });
}

const uniqueTPs = new Set([
  ...deploymentMetaMap.keys(),
  ...detectionsByTP.keys(),
]);
log(`  Unique TP codes across CSVs: ${uniqueTPs.size}`);
log(`  TPs with detection data: ${detectionsByTP.size}`);

// ---------------------------------------------------------------------------
// Phase 2: Match & enrich deployments
// ---------------------------------------------------------------------------

log("\nPhase 2: Matching & enriching deployments...\n");

const allDeployments = db
  .prepare(
    `SELECT id, name, latitude, longitude, date_start, date_end
     FROM biochoco_deployments
     WHERE project_id = 'camera-trap'`
  )
  .all() as DbDeployment[];

log(`  Total camera-trap deployments in DB: ${allDeployments.length}`);

// Match deployments by TP code in name
const tpRegex = /TP-\d+/;
const matchedDeployments = new Map<string, { dbId: number; dbName: string }>();
const unmatchedDeployments: string[] = [];

for (const dep of allDeployments) {
  const match = dep.name.match(tpRegex);
  if (match) {
    const tp = match[0];
    if (deploymentFilter && tp !== deploymentFilter) continue;
    if (uniqueTPs.has(tp)) {
      matchedDeployments.set(tp, { dbId: dep.id, dbName: dep.name });
    }
  }
}

for (const tp of uniqueTPs) {
  if (!matchedDeployments.has(tp)) unmatchedDeployments.push(tp);
}

log(`  Matched deployments: ${matchedDeployments.size}`);
log(
  `  Unmatched TPs (no DB deployment): ${unmatchedDeployments.length}`
);

// Enrich deployments with coordinates, dates, and project label
const updateDeployment = db.prepare(`
  UPDATE biochoco_deployments
  SET latitude = ?, longitude = ?, date_start = ?, date_end = ?,
      project_label = 'Histórico 2014-15', updated_at = unixepoch()
  WHERE id = ?
`);

let enrichedCoords = 0;
let enrichedDates = 0;

function enrichAllDeployments() {
  for (const [tp, { dbId }] of matchedDeployments) {
    const meta = deploymentMetaMap.get(tp);
    if (!meta) continue;

    let lat: number | null = null;
    let lng: number | null = null;

    if (meta.easting && meta.northing) {
      const [lngVal, latVal] = proj4(utm17n, wgs84, [
        meta.easting,
        meta.northing,
      ]);
      lat = Math.round(latVal * 1e6) / 1e6;
      lng = Math.round(lngVal * 1e6) / 1e6;
      enrichedCoords++;
    }

    if (meta.datePlaced || meta.dateRemoved) enrichedDates++;

    if (!dryRun) {
      updateDeployment.run(lat, lng, meta.datePlaced, meta.dateRemoved, dbId);
    }

    log(
      `  ${tp}: lat=${lat ?? "?"}, lng=${lng ?? "?"}, ` +
        `start=${meta.datePlaced ?? "?"}, end=${meta.dateRemoved ?? "?"}`
    );
  }
}

if (dryRun) {
  enrichAllDeployments();
  log(`\n  Would enrich with coordinates: ${enrichedCoords}`);
  log(`  Would enrich with dates: ${enrichedDates}`);
} else {
  db.transaction(enrichAllDeployments)();
  log(`\n  Enriched with coordinates: ${enrichedCoords}`);
  log(`  Enriched with dates: ${enrichedDates}`);
}

// ---------------------------------------------------------------------------
// Phase 3: Match detections & pre-fill species
// ---------------------------------------------------------------------------

log("\nPhase 3: Matching detections & pre-filling species...\n");

// Fix stale corrected_species values from prior runs that used raw CSV strings
const priorRows = db
  .prepare(
    `SELECT id, corrected_species FROM biochoco_identifications
     WHERE verified_by = 'historical-import' AND corrected_species IS NOT NULL`
  )
  .all() as { id: number; corrected_species: string }[];
let fixedPrior = 0;
for (const row of priorRows) {
  const canonical = resolveSpecies(row.corrected_species);
  if (canonical !== row.corrected_species) {
    fixedPrior++;
    if (!dryRun) {
      db.prepare(
        `UPDATE biochoco_identifications SET corrected_species = ? WHERE id = ?`
      ).run(canonical, row.id);
    }
    log(`  Fix prior: "${row.corrected_species}" → "${canonical}" (ident ${row.id})`);
  }
}
if (fixedPrior > 0) {
  log(`  ${dryRun ? "Would fix" : "Fixed"} ${fixedPrior} stale corrected_species from prior runs`);
} else {
  log(`  No stale corrected_species from prior runs`);
}
log("");

// Insert missing species that appear in the CSV but not in biochoco_species
const insertSpecies = db.prepare(`
  INSERT OR IGNORE INTO biochoco_species (scientific_name, common_name, type)
  VALUES (?, ?, ?)
`);
const missingSpecies: [string, string, string][] = [
  ["Automolus ochrolaemus", "Buff-throated foliage-gleaner", "bird"],
  ["Cyphorhinus phaeocephalus", "Song wren", "bird"],
  ["Glyphorynchus spirurus", "Wedge-billed woodcreeper", "bird"],
  ["Hylophylax naevioides", "Spotted antbird", "bird"],
  ["Ortalis erythroptera", "Rufous-headed chachalaca", "bird"],
  ["Rhynchortyx cinctus", "Tawny-faced quail", "bird"],
  ["Turdus maculirostris", "Ecuadorian thrush", "bird"],
];
if (!dryRun) {
  for (const [sci, common, type] of missingSpecies) {
    insertSpecies.run(sci, common, type);
  }
  log(`  Ensured ${missingSpecies.length} missing species exist in biochoco_species`);
} else {
  log(`  Would insert ${missingSpecies.length} missing species into biochoco_species`);
}

// Validate all resolved species exist in biochoco_species (or will be inserted)
const knownSpecies = new Set(
  (db.prepare(`SELECT scientific_name FROM biochoco_species`).all() as { scientific_name: string }[])
    .map((r) => r.scientific_name)
);
// In dry-run mode, also count the species we would insert
if (dryRun) {
  for (const [sci] of missingSpecies) knownSpecies.add(sci);
}
const allResolvedSpecies = new Set<string>();
for (const dets of detectionsByTP.values()) {
  for (const d of dets) allResolvedSpecies.add(d.species);
}
for (const sp of allResolvedSpecies) {
  if (!knownSpecies.has(sp)) {
    log(`  WARNING: resolved species "${sp}" not found in biochoco_species table`);
  }
}
log("");

const queryDetections = db.prepare(`
  SELECT
    v.id AS video_id,
    v.filename AS video_filename,
    img.id AS image_id,
    d.id AS detection_id,
    d.detection_confidence,
    i.id AS ident_id,
    i.species AS ml_species,
    i.verification_status
  FROM biochoco_videos v
  JOIN biochoco_images img ON img.video_id = v.id
  JOIN biochoco_detections d ON d.image_id = img.id
  JOIN biochoco_identifications i ON i.detection_id = d.id
  WHERE v.deployment_id = ?
    AND d.detection_class = 0
    AND i.verification_status = 'unverified'
  ORDER BY v.filename, d.detection_confidence DESC
`);

const queryAllDetections = db.prepare(`
  SELECT
    v.id AS video_id,
    v.filename AS video_filename,
    img.id AS image_id,
    d.id AS detection_id,
    d.detection_confidence,
    i.id AS ident_id,
    i.species AS ml_species,
    i.verification_status
  FROM biochoco_videos v
  JOIN biochoco_images img ON img.video_id = v.id
  JOIN biochoco_detections d ON d.image_id = img.id
  JOIN biochoco_identifications i ON i.detection_id = d.id
  WHERE v.deployment_id = ?
    AND d.detection_class = 0
  ORDER BY v.filename, d.detection_confidence DESC
`);

const queryAllVideos = db.prepare(`
  SELECT id, filename
  FROM biochoco_videos
  WHERE deployment_id = ?
`);

const updateVerified = db.prepare(`
  UPDATE biochoco_identifications
  SET verification_status = 'verified',
      verified_by = 'historical-import',
      verified_at = unixepoch()
  WHERE id = ?
`);

const updateCorrected = db.prepare(`
  UPDATE biochoco_identifications
  SET verification_status = 'corrected',
      corrected_species = ?,
      verified_by = 'historical-import',
      verified_at = unixepoch()
  WHERE id = ?
`);

const updateVerifiedFilename = db.prepare(`
  UPDATE biochoco_identifications
  SET verification_status = 'verified',
      verified_by = 'historical-import-filename',
      verified_at = unixepoch()
  WHERE id = ?
`);

const updateCorrectedFilename = db.prepare(`
  UPDATE biochoco_identifications
  SET verification_status = 'corrected',
      corrected_species = ?,
      verified_by = 'historical-import-filename',
      verified_at = unixepoch()
  WHERE id = ?
`);

// Stats
let totalMatched = 0;
let totalVerified = 0;
let totalCorrected = 0;
let totalCountMismatch = 0;
let totalNoVideo = 0;
let totalNoMlDetections = 0;
let totalAlreadyProcessed = 0;
let filenameFallbackMatched = 0;
let filenameFallbackVerified = 0;
let filenameFallbackCorrected = 0;
const unmatchedFilenames: Array<{
  tp: string;
  filename: string;
  species: string;
  count: number;
  date: string | null;
  reason: string;
}> = [];

function assignSpeciesToDetections(
  tp: string,
  csvDets: CsvDetection[],
  dbDets: DbDetectionRow[]
) {
  if (dbDets.length === 0) return;

  // All frames from the same video show the same event.
  // Assign the CSV species to ALL detections across all frames,
  // not just the top N by count.
  // When multiple CSV species share the same prefix (rare), assign each
  // species proportionally by count, highest-confidence detections first.
  const totalCsvCount = csvDets.reduce((sum, d) => sum + d.count, 0);
  const isSingleSpecies = csvDets.length === 1;

  if (isSingleSpecies) {
    // Common case: one species for this video — assign to ALL detections
    const species = csvDets[0].species;
    for (const det of dbDets) {
      const prefix = extractFilePrefix(det.video_filename);
      if (det.ml_species === species) {
        totalVerified++;
        if (!dryRun) updateVerified.run(det.ident_id);
        log(`  ${tp}: ${prefix} — ${det.ml_species} → ${species} (verified)`);
      } else {
        totalCorrected++;
        if (!dryRun) updateCorrected.run(species, det.ident_id);
        log(`  ${tp}: ${prefix} — ${det.ml_species} → ${species} (corrected)`);
      }
      totalMatched++;
    }
  } else {
    // Multi-species: assign proportionally by count, then overflow remainder
    // to the last species. Highest confidence detections first (already sorted).
    if (dbDets.length !== totalCsvCount) totalCountMismatch++;
    let detIdx = 0;
    for (const csvDet of csvDets) {
      const toAssign = Math.min(csvDet.count, dbDets.length - detIdx);
      for (let i = 0; i < toAssign; i++) {
        const det = dbDets[detIdx++];
        if (!det) break;
        const prefix = extractFilePrefix(det.video_filename);
        if (det.ml_species === csvDet.species) {
          totalVerified++;
          if (!dryRun) updateVerified.run(det.ident_id);
          log(`  ${tp}: ${prefix} — ${det.ml_species} → ${csvDet.species} (verified)`);
        } else {
          totalCorrected++;
          if (!dryRun) updateCorrected.run(csvDet.species, det.ident_id);
          log(`  ${tp}: ${prefix} — ${det.ml_species} → ${csvDet.species} (corrected)`);
        }
        totalMatched++;
      }
    }
    // Assign any remaining detections to the last species
    const lastSpecies = csvDets[csvDets.length - 1].species;
    while (detIdx < dbDets.length) {
      const det = dbDets[detIdx++];
      const prefix = extractFilePrefix(det.video_filename);
      if (det.ml_species === lastSpecies) {
        totalVerified++;
        if (!dryRun) updateVerified.run(det.ident_id);
        log(`  ${tp}: ${prefix} — ${det.ml_species} → ${lastSpecies} (verified)`);
      } else {
        totalCorrected++;
        if (!dryRun) updateCorrected.run(lastSpecies, det.ident_id);
        log(`  ${tp}: ${prefix} — ${det.ml_species} → ${lastSpecies} (corrected)`);
      }
      totalMatched++;
    }
  }
}

function assignSpeciesFromFilename(
  tp: string,
  species: string,
  dbDets: DbDetectionRow[]
) {
  for (const det of dbDets) {
    const prefix = extractFilePrefix(det.video_filename);
    if (det.ml_species === species) {
      filenameFallbackVerified++;
      if (!dryRun) updateVerifiedFilename.run(det.ident_id);
      log(`  ${tp}: ${prefix} — ${det.ml_species} → ${species} (verified, filename-fallback)`);
    } else {
      filenameFallbackCorrected++;
      if (!dryRun) updateCorrectedFilename.run(species, det.ident_id);
      log(`  ${tp}: ${prefix} — ${det.ml_species} → ${species} (corrected, filename-fallback)`);
    }
    filenameFallbackMatched++;
  }
}

function matchAllDetections() {
  for (const [tp, { dbId }] of matchedDeployments) {
    const csvDetections = detectionsByTP.get(tp);
    const hasCsvData = csvDetections && csvDetections.length > 0;

    // Query unverified ML detections (available for assignment)
    const detRows = queryDetections.all(dbId) as DbDetectionRow[];

    // Skip deployment if no unverified detections AND no CSV data
    if (detRows.length === 0 && !hasCsvData) continue;

    // Build prefix → unverified detection rows map (always needed for filename fallback)
    const detByPrefix = new Map<string, DbDetectionRow[]>();
    for (const row of detRows) {
      const prefix = extractFilePrefix(row.video_filename);
      if (!detByPrefix.has(prefix)) detByPrefix.set(prefix, []);
      detByPrefix.get(prefix)!.push(row);
    }

    // Track all prefixes that CSV claims (even if unmatched), so filename
    // fallback never overrides CSV data
    const csvMatchedPrefixes = new Set<string>();

    if (hasCsvData) {
      // Query ALL ML detections regardless of verification status
      const allDetRows = queryAllDetections.all(dbId) as DbDetectionRow[];

      // Query ALL videos in deployment (for distinguishing "no video" vs "no ML detections")
      const allVideos = queryAllVideos.all(dbId) as DbVideoRow[];

      // Build prefix → all detection rows map (for distinguishing "no detections" vs "already processed")
      const allDetByPrefix = new Map<string, DbDetectionRow[]>();
      for (const row of allDetRows) {
        const prefix = extractFilePrefix(row.video_filename);
        if (!allDetByPrefix.has(prefix)) allDetByPrefix.set(prefix, []);
        allDetByPrefix.get(prefix)!.push(row);
      }

      // Build prefix → video exists map (all videos, not just those with detections)
      const allVideosByPrefix = new Map<string, DbVideoRow>();
      for (const v of allVideos) {
        const prefix = extractFilePrefix(v.filename);
        allVideosByPrefix.set(prefix, v);
      }

      // Build prefix → CSV detections map
      const csvByPrefix = new Map<string, CsvDetection[]>();
      for (const det of csvDetections) {
        const prefix = extractFilePrefix(det.filename);
        if (!csvByPrefix.has(prefix)) csvByPrefix.set(prefix, []);
        csvByPrefix.get(prefix)!.push(det);
      }

      // Warn about prefix collisions (multiple CSV entries with same prefix but different species)
      for (const [prefix, dets] of csvByPrefix) {
        const uniqueSpecies = new Set(dets.map((d) => d.species));
        if (uniqueSpecies.size > 1) {
          log(
            `  WARNING: ${tp} prefix "${prefix}" has ${uniqueSpecies.size} species: ${[...uniqueSpecies].join(", ")} — may need (2) disambiguator`
          );
        }
      }

      // CSV matching loop
      for (const [prefix, csvDets] of csvByPrefix) {
        csvMatchedPrefixes.add(prefix);
        const dbDets = detByPrefix.get(prefix);

        if (dbDets && dbDets.length > 0) {
          assignSpeciesToDetections(tp, csvDets, dbDets);
          continue;
        }

        // No unverified detections for this prefix — check why
        const allDetsForPrefix = allDetByPrefix.get(prefix);
        if (allVideosByPrefix.has(prefix) && allDetsForPrefix && allDetsForPrefix.length > 0) {
          // Detections exist but all are already verified/corrected (prior run)
          totalAlreadyProcessed++;
          for (const det of csvDets) {
            unmatchedFilenames.push({
              tp,
              filename: det.filename,
              species: det.species,
              count: det.count,
              date: det.date,
              reason: "all detections already processed (prior run)",
            });
          }
        } else if (allVideosByPrefix.has(prefix)) {
          // Video exists but MegaDetector found no animals at all
          totalNoMlDetections++;
          for (const det of csvDets) {
            unmatchedFilenames.push({
              tp,
              filename: det.filename,
              species: det.species,
              count: det.count,
              date: det.date,
              reason: "video exists but MegaDetector found no animals",
            });
          }
        } else {
          // No video in DB at all
          totalNoVideo++;
          for (const det of csvDets) {
            unmatchedFilenames.push({
              tp,
              filename: det.filename,
              species: det.species,
              count: det.count,
              date: det.date,
              reason: "no video matching prefix",
            });
          }
        }
      }
    }

    // Filename fallback: check unverified detections not covered by CSV
    for (const [prefix, dbDets] of detByPrefix) {
      if (csvMatchedPrefixes.has(prefix)) continue;
      // Use the first video filename to check for species keywords
      const videoFilename = dbDets[0].video_filename;
      const species = resolveSpeciesFromFilename(videoFilename);
      if (species) {
        assignSpeciesFromFilename(tp, species, dbDets);
      }
    }
  }
}

if (dryRun) {
  matchAllDetections();
} else {
  db.transaction(matchAllDetections)();
}

// ---------------------------------------------------------------------------
// Write unmatched-no-ml-detection CSV
// ---------------------------------------------------------------------------

const noMlRows = unmatchedFilenames.filter((u) =>
  u.reason.includes("MegaDetector")
);
if (noMlRows.length > 0) {
  const csvPath = path.join(
    CSV_DIR,
    `unmatched-no-ml-detection-${RUN_TIMESTAMP}.csv`
  );
  const header = "tp,filename,species,count,date,reason";
  const lines = noMlRows.map(
    (r) =>
      `${r.tp},"${r.filename}",${r.species},${r.count},${r.date ?? ""},${r.reason}`
  );
  writeFileSync(csvPath, [header, ...lines].join("\n") + "\n");
  log(`\nWrote ${noMlRows.length} no-ML-detection rows to:`);
  log(`  ${csvPath}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

log("\n======================================");
log("Historical Camera Trap Import Summary");
log("======================================");
log(
  `Deployments: ${matchedDeployments.size} matched, ${unmatchedDeployments.length} unmatched`
);
log(`  Enriched with coordinates: ${enrichedCoords}`);
log(`  Enriched with dates: ${enrichedDates}`);
log(
  `Detections (CSV): ${totalMatched} matched, ${totalNoVideo + totalNoMlDetections} unmatched`
);
log(`  Verified (ML matched): ${totalVerified}`);
log(`  Corrected (species updated): ${totalCorrected}`);
log(`  Already processed (prior run): ${totalAlreadyProcessed}`);
log(`  Warnings (count mismatch): ${totalCountMismatch}`);
log(`  No video in DB: ${totalNoVideo}`);
log(`Detections (filename fallback): ${filenameFallbackMatched} matched`);
log(`  Verified (ML matched): ${filenameFallbackVerified}`);
log(`  Corrected (species updated): ${filenameFallbackCorrected}`);
log(`  Video exists, no ML detections: ${totalNoMlDetections}`);

if (unmatchedDeployments.length > 0) {
  log(`\n  Unmatched TP codes (${unmatchedDeployments.length}):`);
  log(formatCompactList(unmatchedDeployments.sort(), "    "));
}

if (unmatchedFilenames.length > 0) {
  log(
    `\nUnmatched filenames (${unmatchedFilenames.length} total):`
  );
  for (const { tp, filename, species, reason } of unmatchedFilenames) {
    log(`  - ${tp}: ${filename} [${species}] (${reason})`);
  }
}

if (dryRun) {
  log("\n*** DRY RUN — no changes were written ***");
}

log(`\nLog file: ${LOG_FILE}`);
db.close();
log("Done.");
