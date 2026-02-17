/**
 * Import historical camera trap data from 2014 CSVs.
 *
 * Enriches deployments with coordinates/dates from Camera_log,
 * and pre-fills species identifications from species detection data.
 *
 * Run AFTER Drive sync + MegaDetector processing.
 *
 * Usage:
 *   npx tsx scripts/import-historical-camera-data.ts [--dry-run] [--deployment TP-062]
 */

import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import path from "path";
import proj4 from "proj4";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CSV_DIR =
  "/Users/luke/apps/BioChoco/.worktrees/camera-trap-integration/data/historical_camera_data";

const CAMERA_LOG_FILE = "Camera_log 2015_01_12.csv";
const SPECIES_DETECTION_FILE = "species detection data 2020_03_17(in).csv";

const utm17n = "+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs";
const wgs84 = "+proj=longlat +datum=WGS84 +no_defs";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const deploymentFilterIdx = args.indexOf("--deployment");
const deploymentFilter =
  deploymentFilterIdx !== -1 ? args[deploymentFilterIdx + 1] : null;

if (dryRun) console.log("*** DRY RUN — no changes will be written ***\n");
if (deploymentFilter)
  console.log(`Filtering to deployment: ${deploymentFilter}\n`);

if (!dryRun) {
  console.log(
    "WARNING: This will modify the database. Make sure you have a backup!\n" +
      "  Run: node scripts/backup-db.mjs\n" +
      "  Or use --dry-run to preview changes first.\n"
  );
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

// ---------------------------------------------------------------------------
// Phase 1: Parse CSVs + build maps
// ---------------------------------------------------------------------------

console.log("Phase 1: Parsing CSVs...\n");

const cameraLogRows = loadCSV(CAMERA_LOG_FILE);
const speciesDetectionRows = loadCSV(SPECIES_DETECTION_FILE);

console.log(`  Camera_log: ${cameraLogRows.length} rows`);
console.log(`  Species detection data: ${speciesDetectionRows.length} rows`);

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

console.log(`  Deployment metadata entries: ${deploymentMetaMap.size}`);

// Detection data from species detection CSV
const detectionsByTP = new Map<string, CsvDetection[]>();

for (const row of speciesDetectionRows) {
  const tp = row["trapping_period"]?.trim();
  if (!tp) continue;
  if (deploymentFilter && tp !== deploymentFilter) continue;

  const filename = row["file_name"]?.trim();
  const species = row["species"]?.trim();
  const countStr = row["n_animals"]?.trim();
  const count = countStr ? parseInt(countStr) : 1;
  const date = normalizeDate(row["date_video"] || "");

  if (!filename || !species) continue;

  if (!detectionsByTP.has(tp)) detectionsByTP.set(tp, []);
  detectionsByTP.get(tp)!.push({ filename, species, count, date });
}

const uniqueTPs = new Set([
  ...deploymentMetaMap.keys(),
  ...detectionsByTP.keys(),
]);
console.log(`  Unique TP codes across CSVs: ${uniqueTPs.size}`);
console.log(`  TPs with detection data: ${detectionsByTP.size}`);

// ---------------------------------------------------------------------------
// Phase 2: Match & enrich deployments
// ---------------------------------------------------------------------------

console.log("\nPhase 2: Matching & enriching deployments...\n");

const allDeployments = db
  .prepare(
    `SELECT id, name, latitude, longitude, date_start, date_end
     FROM biochoco_deployments
     WHERE project_id = 'camera-trap'`
  )
  .all() as DbDeployment[];

console.log(`  Total camera-trap deployments in DB: ${allDeployments.length}`);

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

console.log(`  Matched deployments: ${matchedDeployments.size}`);
console.log(
  `  Unmatched TPs (no DB deployment): ${unmatchedDeployments.length}`
);
if (unmatchedDeployments.length > 0) {
  console.log(`  Unmatched TP codes:`);
  for (const tp of unmatchedDeployments.sort()) {
    console.log(`    - ${tp}`);
  }
}

// Enrich deployments with coordinates and dates
const updateDeployment = db.prepare(`
  UPDATE biochoco_deployments
  SET latitude = ?, longitude = ?, date_start = ?, date_end = ?, updated_at = unixepoch()
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

    console.log(
      `  ${tp}: lat=${lat ?? "?"}, lng=${lng ?? "?"}, ` +
        `start=${meta.datePlaced ?? "?"}, end=${meta.dateRemoved ?? "?"}`
    );
  }
}

if (dryRun) {
  enrichAllDeployments();
  console.log(`\n  Would enrich with coordinates: ${enrichedCoords}`);
  console.log(`  Would enrich with dates: ${enrichedDates}`);
} else {
  db.transaction(enrichAllDeployments)();
  console.log(`\n  Enriched with coordinates: ${enrichedCoords}`);
  console.log(`  Enriched with dates: ${enrichedDates}`);
}

// ---------------------------------------------------------------------------
// Phase 3: Match detections & pre-fill species
// ---------------------------------------------------------------------------

console.log("\nPhase 3: Matching detections & pre-filling species...\n");

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

// Stats
let totalMatched = 0;
let totalVerified = 0;
let totalCorrected = 0;
let totalCountMismatch = 0;
let totalNoVideo = 0;
let totalNoDetections = 0;
const unmatchedFilenames: Array<{
  tp: string;
  filename: string;
  reason: string;
}> = [];

function assignSpeciesToDetections(
  tp: string,
  csvDets: CsvDetection[],
  dbDets: DbDetectionRow[]
) {
  const totalExpected = csvDets.reduce((sum, d) => sum + d.count, 0);
  const available = [...dbDets]; // copy, already sorted by confidence DESC

  if (available.length === 0) {
    totalNoDetections++;
    for (const det of csvDets) {
      unmatchedFilenames.push({
        tp,
        filename: det.filename,
        reason: "no unverified detections on video",
      });
    }
    return;
  }

  if (available.length !== totalExpected) totalCountMismatch++;

  // Assign species to detections, highest confidence first
  let detIdx = 0;
  for (const csvDet of csvDets) {
    const toAssign = Math.min(csvDet.count, available.length - detIdx);
    for (let i = 0; i < toAssign; i++) {
      const det = available[detIdx++];
      if (!det) break;

      if (det.ml_species === csvDet.species) {
        totalVerified++;
        if (!dryRun) updateVerified.run(det.ident_id);
      } else {
        totalCorrected++;
        if (!dryRun) updateCorrected.run(csvDet.species, det.ident_id);
      }
      totalMatched++;
    }
  }
}

function matchAllDetections() {
  for (const [tp, { dbId }] of matchedDeployments) {
    const csvDetections = detectionsByTP.get(tp);
    if (!csvDetections || csvDetections.length === 0) continue;

    // One query per deployment
    const rows = queryDetections.all(dbId) as DbDetectionRow[];

    // Build lookup: lowercase video filename → detection rows
    const detByFilename = new Map<string, DbDetectionRow[]>();
    for (const row of rows) {
      const key = row.video_filename.toLowerCase();
      if (!detByFilename.has(key)) detByFilename.set(key, []);
      detByFilename.get(key)!.push(row);
    }

    // Group CSV detections by filename (multi-species per video)
    const csvByFilename = new Map<string, CsvDetection[]>();
    for (const det of csvDetections) {
      const key = det.filename.toLowerCase();
      if (!csvByFilename.has(key)) csvByFilename.set(key, []);
      csvByFilename.get(key)!.push(det);
    }

    for (const [filenameKey, csvDets] of csvByFilename) {
      const dbDets = detByFilename.get(filenameKey);

      if (dbDets && dbDets.length > 0) {
        assignSpeciesToDetections(tp, csvDets, dbDets);
        continue;
      }

      // Try partial match (filename without extension)
      const baseName = filenameKey.replace(/\.\w+$/, "");
      let found = false;
      for (const [dbKey, dbRows] of detByFilename) {
        if (dbKey.startsWith(baseName) || dbKey.includes(baseName)) {
          assignSpeciesToDetections(tp, csvDets, dbRows);
          found = true;
          break;
        }
      }

      if (!found) {
        totalNoVideo++;
        for (const det of csvDets) {
          unmatchedFilenames.push({
            tp,
            filename: det.filename,
            reason:
              rows.length === 0
                ? "no detections in deployment"
                : "no video row found",
          });
        }
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
// Summary
// ---------------------------------------------------------------------------

console.log("======================================");
console.log("Historical Camera Trap Import Summary");
console.log("======================================");
console.log(
  `Deployments: ${matchedDeployments.size} matched, ${unmatchedDeployments.length} unmatched`
);
console.log(`  Enriched with coordinates: ${enrichedCoords}`);
console.log(`  Enriched with dates: ${enrichedDates}`);
console.log(
  `Detections: ${totalMatched} matched, ${totalNoVideo + totalNoDetections} unmatched`
);
console.log(`  Verified (ML matched): ${totalVerified}`);
console.log(`  Corrected (species updated): ${totalCorrected}`);
console.log(`  Warnings (count mismatch): ${totalCountMismatch}`);
console.log(`  No video found: ${totalNoVideo}`);
console.log(`  No detections on video: ${totalNoDetections}`);

if (unmatchedDeployments.length > 0) {
  console.log(`\nUnmatched TP codes (not in DB):`);
  for (const tp of unmatchedDeployments.sort()) {
    console.log(`  - ${tp}`);
  }
}

if (unmatchedFilenames.length > 0) {
  const maxShow = 30;
  console.log(
    `\nUnmatched filenames (${unmatchedFilenames.length} total, showing first ${Math.min(maxShow, unmatchedFilenames.length)}):`
  );
  for (const { tp, filename, reason } of unmatchedFilenames.slice(0, maxShow)) {
    console.log(`  - ${tp}: ${filename} (${reason})`);
  }
  if (unmatchedFilenames.length > maxShow) {
    console.log(`  ... and ${unmatchedFilenames.length - maxShow} more`);
  }
}

if (dryRun) {
  console.log("\n*** DRY RUN — no changes were written ***");
}

db.close();
console.log("\nDone.");
