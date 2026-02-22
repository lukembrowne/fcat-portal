/**
 * Push database schema directly via SQL.
 *
 * drizzle-kit push is interactive and doesn't work well in CI/CLI.
 * This script creates all tables and indexes directly.
 *
 * Usage: node scripts/push-schema.mjs
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dbPath = process.env.DB_PATH || "data/portal.db";
const fullPath = path.isAbsolute(dbPath)
  ? dbPath
  : path.join(process.cwd(), dbPath);

// Ensure directory exists
const dir = path.dirname(fullPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(fullPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const statements = [
  // Users
  `CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT,
    is_external INTEGER NOT NULL DEFAULT 0,
    global_role TEXT CHECK(global_role IN ('super_admin')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Projects
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // User Permissions
  `CREATE TABLE IF NOT EXISTS user_permissions (
    user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('viewer', 'editor', 'admin')),
    granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_email, project_id)
  )`,

  // BioChoco — Deployments (camera trap installations)
  `CREATE TABLE IF NOT EXISTS biochoco_deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT,
    name TEXT NOT NULL,
    drive_folder_id TEXT,
    latitude REAL,
    longitude REAL,
    date_start TEXT,
    date_end TEXT,
    total_images INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unscanned' CHECK(status IN ('unscanned', 'scanned', 'processing', 'processed', 'verified', 'verified_empty')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_by TEXT
  )`,

  // BioChoco — Processing Jobs
  `CREATE TABLE IF NOT EXISTS biochoco_processing_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    detector_model TEXT,
    classifier_model TEXT,
    confidence_threshold REAL DEFAULT 0.1,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    pid INTEGER,
    total_images INTEGER NOT NULL DEFAULT 0,
    processed_images INTEGER NOT NULL DEFAULT 0,
    failed_images INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_by TEXT
  )`,

  // BioChoco — Images
  `CREATE TABLE IF NOT EXISTS biochoco_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES biochoco_processing_jobs(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    path TEXT,
    drive_file_id TEXT,
    file_size INTEGER,
    file_modified INTEGER,
    exif_timestamp TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processed', 'failed')),
    error_message TEXT,
    thumbnail_path TEXT,
    confirmed_blank INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    starred_by TEXT,
    starred_at INTEGER
  )`,

  // BioChoco — Detections
  `CREATE TABLE IF NOT EXISTS biochoco_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES biochoco_images(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES biochoco_processing_jobs(id) ON DELETE SET NULL,
    bbox_x REAL NOT NULL,
    bbox_y REAL NOT NULL,
    bbox_width REAL NOT NULL,
    bbox_height REAL NOT NULL,
    detection_confidence REAL NOT NULL,
    detection_class INTEGER NOT NULL DEFAULT 0,
    model_version TEXT
  )`,

  // BioChoco — Identifications
  `CREATE TABLE IF NOT EXISTS biochoco_identifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detection_id INTEGER NOT NULL REFERENCES biochoco_detections(id) ON DELETE CASCADE,
    species TEXT NOT NULL,
    confidence REAL NOT NULL,
    model_version TEXT,
    verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('unverified', 'verified', 'rejected', 'corrected')),
    corrected_species TEXT,
    verified_by TEXT,
    verified_at INTEGER
  )`,

  // BioChoco — Videos (camera trap video files)
  `CREATE TABLE IF NOT EXISTS biochoco_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    drive_file_id TEXT,
    file_size INTEGER,
    file_modified INTEGER,
    path TEXT,
    duration REAL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processed', 'failed')),
    error_message TEXT
  )`,

  // BioChoco — Species
  `CREATE TABLE IF NOT EXISTS biochoco_species (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scientific_name TEXT NOT NULL UNIQUE,
    common_name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'mammal' CHECK(type IN ('mammal', 'bird', 'reptile', 'amphibian', 'insect', 'system'))
  )`,

  // Activity Log
  `CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    action TEXT NOT NULL,
    project_id TEXT,
    target_type TEXT,
    target_id TEXT,
    details TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Finance — Transactions
  `CREATE TABLE IF NOT EXISTS finance_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    codigo TEXT NOT NULL,
    cuenta_nombre TEXT NOT NULL,
    asiento TEXT NOT NULL,
    detalle TEXT,
    actor TEXT,
    centros_de_ingreso TEXT,
    c_costo TEXT,
    debe REAL NOT NULL DEFAULT 0,
    haber REAL NOT NULL DEFAULT 0,
    balance REAL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    year_month TEXT NOT NULL,
    tx_type TEXT NOT NULL CHECK(tx_type IN ('revenue', 'expense', 'cash', 'other'))
  )`,

  // Finance — Budget Items
  `CREATE TABLE IF NOT EXISTS finance_budget_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_year INTEGER NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL
  )`,

  // Finance — Category Map
  `CREATE TABLE IF NOT EXISTS finance_category_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_category TEXT NOT NULL,
    link_expense_category TEXT NOT NULL
  )`,

  // Finance — Sueldos Grants
  `CREATE TABLE IF NOT EXISTS finance_sueldos_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('funded', 'pending')),
    amount REAL NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL
  )`,

  // Finance — Sueldos Totals
  `CREATE TABLE IF NOT EXISTS finance_sueldos_totals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person TEXT NOT NULL UNIQUE,
    annual_cost REAL NOT NULL,
    monthly_cost REAL NOT NULL
  )`,

  // Finance — Projections
  `CREATE TABLE IF NOT EXISTS finance_projections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'very_likely', 'maybe')),
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    include_in_projection INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Finance — Uploads
  `CREATE TABLE IF NOT EXISTS finance_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_type TEXT NOT NULL CHECK(file_type IN ('libro_mayor', 'budget', 'category_map', 'sueldos')),
    file_name TEXT NOT NULL,
    row_count INTEGER,
    uploaded_by TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_user_permissions_user_email ON user_permissions(user_email)`,
  `CREATE INDEX IF NOT EXISTS idx_user_permissions_project_id ON user_permissions(project_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_deployments_project_path ON biochoco_deployments(project_id, path)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_deployments_project_drive_folder ON biochoco_deployments(project_id, drive_folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_biochoco_images_deployment_id ON biochoco_images(deployment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_biochoco_images_job_id ON biochoco_images(job_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_images_deployment_drive_file ON biochoco_images(deployment_id, drive_file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_biochoco_detections_image_id ON biochoco_detections(image_id)`,
  `CREATE INDEX IF NOT EXISTS idx_biochoco_detections_job_id ON biochoco_detections(job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_biochoco_identifications_detection_id ON biochoco_identifications(detection_id)`,
  `CREATE INDEX IF NOT EXISTS idx_biochoco_videos_deployment_id ON biochoco_videos(deployment_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_videos_deployment_drive_file ON biochoco_videos(deployment_id, drive_file_id)`,

  // Finance indexes
  `CREATE INDEX IF NOT EXISTS idx_ft_fecha ON finance_transactions(fecha)`,
  `CREATE INDEX IF NOT EXISTS idx_ft_codigo ON finance_transactions(codigo)`,
  `CREATE INDEX IF NOT EXISTS idx_ft_tx_type ON finance_transactions(tx_type)`,
  `CREATE INDEX IF NOT EXISTS idx_ft_year_month ON finance_transactions(year_month)`,
  `CREATE INDEX IF NOT EXISTS idx_fcm_budget_cat ON finance_category_map(budget_category)`,
  `CREATE INDEX IF NOT EXISTS idx_fcm_link_cat ON finance_category_map(link_expense_category)`,

  // Climate — Readings (hourly + 15-min weather station data)
  `CREATE TABLE IF NOT EXISTS climate_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK(resolution IN ('hourly', '15min')),
    record_num INTEGER,
    air_temp_avg REAL,
    air_temp_max REAL,
    air_temp_min REAL,
    humidity_avg REAL,
    humidity_max REAL,
    humidity_min REAL,
    pressure_avg REAL,
    pressure_max REAL,
    pressure_min REAL,
    rain_mm REAL,
    solar_avg REAL,
    solar_max REAL,
    solar_min REAL,
    wind_dir_avg REAL,
    wind_dir_max REAL,
    wind_dir_min REAL,
    wind_speed_avg REAL,
    wind_speed_max REAL,
    wind_speed_min REAL,
    mean_wind_speed REAL,
    mean_wind_direction REAL,
    std_wind_dir REAL,
    UNIQUE(timestamp, resolution)
  )`,

  // Climate — Uploads (tracking data imports)
  `CREATE TABLE IF NOT EXISTS climate_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK(resolution IN ('hourly', '15min')),
    rows_imported INTEGER NOT NULL,
    date_range_start TEXT,
    date_range_end TEXT,
    uploaded_by TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Climate — Edits (audit trail for manual data corrections)
  `CREATE TABLE IF NOT EXISTS climate_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK(resolution IN ('hourly', '15min')),
    column_name TEXT NOT NULL,
    old_value REAL,
    edited_by TEXT NOT NULL,
    edited_at INTEGER NOT NULL DEFAULT (unixepoch()),
    reason TEXT
  )`,

  // Climate indexes
  `CREATE INDEX IF NOT EXISTS idx_climate_readings_res_ts ON climate_readings(resolution, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_climate_edits_ts_res ON climate_edits(timestamp, resolution)`,
];

for (const stmt of statements) {
  db.exec(stmt);
}

// --- Migrations (ALTER TABLE additions, idempotent) ---
const migrations = [
  `ALTER TABLE users ADD COLUMN last_seen_at INTEGER`,
  // Google Drive camera trap columns (for DBs created before biochoco_ prefix)
  `ALTER TABLE biochoco_deployments ADD COLUMN drive_folder_id TEXT`,
  `ALTER TABLE biochoco_images ADD COLUMN drive_file_id TEXT`,
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN status_message TEXT`,
  // Camera trap redesign columns
  `ALTER TABLE biochoco_deployments ADD COLUMN project_label TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN site_name TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN odk_submission_id TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN metadata_source TEXT`,
  // Species table enhancements
  `ALTER TABLE biochoco_species ADD COLUMN spanish_name TEXT`,
  `ALTER TABLE biochoco_species ADD COLUMN taxonomic_rank TEXT NOT NULL DEFAULT 'species'`,
  // Video processing support
  `ALTER TABLE biochoco_deployments ADD COLUMN total_videos INTEGER DEFAULT 0`,
  `ALTER TABLE biochoco_images ADD COLUMN video_id INTEGER REFERENCES biochoco_videos(id) ON DELETE CASCADE`,
  `ALTER TABLE biochoco_images ADD COLUMN frame_index INTEGER`,
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN frame_extraction_rate REAL DEFAULT 1.0`,
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN total_videos INTEGER DEFAULT 0`,
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN extracted_frames INTEGER DEFAULT 0`,
  // Per-image blank confirmation
  `ALTER TABLE biochoco_images ADD COLUMN confirmed_blank INTEGER NOT NULL DEFAULT 0`,
  // Image starring/favorites (2026-02-18)
  `ALTER TABLE biochoco_images ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE biochoco_images ADD COLUMN starred_by TEXT`,
  `ALTER TABLE biochoco_images ADD COLUMN starred_at INTEGER`,
];
for (const m of migrations) {
  try { db.exec(m); } catch { /* column already exists */ }
}

// --- Post-migration indexes (depend on columns added by migrations) ---
const postMigrationIndexes = [
  `CREATE INDEX IF NOT EXISTS idx_biochoco_images_starred ON biochoco_images(starred) WHERE starred = 1`,
];
for (const idx of postMigrationIndexes) {
  db.exec(idx);
}

// --- Table recreations ---
// IMPORTANT: Disable foreign keys during table recreation to prevent
// CASCADE deletes when dropping parent tables (the DROP would otherwise
// cascade-delete all rows in child tables like processing_jobs, images, etc.)
db.pragma("foreign_keys = OFF");

// Make biochoco_deployments.path nullable
// SQLite cannot ALTER column constraints, so we recreate the table
try {
  const hasNotNull = db
    .prepare(`SELECT "notnull" FROM pragma_table_info('biochoco_deployments') WHERE name = 'path'`)
    .get();
  if (hasNotNull && hasNotNull.notnull === 1) {
    console.log("Migrating biochoco_deployments table: making path nullable...");
    db.exec(`BEGIN TRANSACTION`);
    db.exec(`CREATE TABLE biochoco_deployments_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT,
      name TEXT NOT NULL,
      drive_folder_id TEXT,
      latitude REAL,
      longitude REAL,
      date_start TEXT,
      date_end TEXT,
      total_images INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unscanned' CHECK(status IN ('unscanned', 'scanned', 'processing', 'processed', 'verified', 'verified_empty')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by TEXT
    )`);
    db.exec(`INSERT INTO biochoco_deployments_new SELECT id, project_id, path, name, drive_folder_id, latitude, longitude, date_start, date_end, total_images, status, created_at, updated_at, created_by FROM biochoco_deployments`);
    db.exec(`DROP TABLE biochoco_deployments`);
    db.exec(`ALTER TABLE biochoco_deployments_new RENAME TO biochoco_deployments`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_deployments_project_path ON biochoco_deployments(project_id, path)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_deployments_project_drive_folder ON biochoco_deployments(project_id, drive_folder_id)`);
    db.exec(`COMMIT`);
    console.log("  biochoco_deployments.path is now nullable");
  }
} catch (err) {
  try { db.exec(`ROLLBACK`); } catch { /* no active tx */ }
  console.error("Failed to migrate biochoco_deployments table:", err.message);
}

// --- Table recreation: make biochoco_images.path nullable ---
try {
  const hasNotNull = db
    .prepare(`SELECT "notnull" FROM pragma_table_info('biochoco_images') WHERE name = 'path'`)
    .get();
  if (hasNotNull && hasNotNull.notnull === 1) {
    console.log("Migrating biochoco_images table: making path nullable...");
    db.exec(`BEGIN TRANSACTION`);
    db.exec(`CREATE TABLE biochoco_images_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
      job_id INTEGER REFERENCES biochoco_processing_jobs(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      path TEXT,
      drive_file_id TEXT,
      file_size INTEGER,
      file_modified INTEGER,
      exif_timestamp TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processed', 'failed')),
      error_message TEXT,
      thumbnail_path TEXT
    )`);
    db.exec(`INSERT INTO biochoco_images_new SELECT id, deployment_id, job_id, filename, path, drive_file_id, file_size, file_modified, exif_timestamp, status, error_message, thumbnail_path FROM biochoco_images`);
    db.exec(`DROP TABLE biochoco_images`);
    db.exec(`ALTER TABLE biochoco_images_new RENAME TO biochoco_images`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_biochoco_images_deployment_id ON biochoco_images(deployment_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_biochoco_images_job_id ON biochoco_images(job_id)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_images_deployment_drive_file ON biochoco_images(deployment_id, drive_file_id)`);
    db.exec(`COMMIT`);
    console.log("  biochoco_images.path is now nullable");
  }
} catch (err) {
  try { db.exec(`ROLLBACK`); } catch { /* no active tx */ }
  console.error("Failed to migrate biochoco_images table:", err.message);
}

// --- Table recreation: make biochoco_detections.job_id nullable with ON DELETE SET NULL ---
try {
  const jobIdInfo = db
    .prepare(`SELECT "notnull" FROM pragma_table_info('biochoco_detections') WHERE name = 'job_id'`)
    .get();
  if (jobIdInfo && jobIdInfo.notnull === 1) {
    console.log("Migrating biochoco_detections table: making job_id nullable with ON DELETE SET NULL...");
    db.exec(`BEGIN TRANSACTION`);
    db.exec(`CREATE TABLE biochoco_detections_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES biochoco_images(id) ON DELETE CASCADE,
      job_id INTEGER REFERENCES biochoco_processing_jobs(id) ON DELETE SET NULL,
      bbox_x REAL NOT NULL,
      bbox_y REAL NOT NULL,
      bbox_width REAL NOT NULL,
      bbox_height REAL NOT NULL,
      detection_confidence REAL NOT NULL,
      detection_class INTEGER NOT NULL DEFAULT 0,
      model_version TEXT
    )`);
    db.exec(`INSERT INTO biochoco_detections_new SELECT id, image_id, job_id, bbox_x, bbox_y, bbox_width, bbox_height, detection_confidence, detection_class, model_version FROM biochoco_detections`);
    db.exec(`DROP TABLE biochoco_detections`);
    db.exec(`ALTER TABLE biochoco_detections_new RENAME TO biochoco_detections`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_biochoco_detections_image_id ON biochoco_detections(image_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_biochoco_detections_job_id ON biochoco_detections(job_id)`);
    db.exec(`COMMIT`);
    console.log("  biochoco_detections.job_id is now nullable with ON DELETE SET NULL");
  }
} catch (err) {
  try { db.exec(`ROLLBACK`); } catch { /* no active tx */ }
  console.error("Failed to migrate biochoco_detections table:", err.message);
}

// --- Table recreation: add verified_empty to deployment status CHECK constraint ---
try {
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='biochoco_deployments'")
    .get();
  if (tableInfo && !tableInfo.sql.includes('verified_empty')) {
    console.log("Migrating biochoco_deployments table: adding verified_empty status...");
    db.exec(`BEGIN TRANSACTION`);
    db.exec(`CREATE TABLE biochoco_deployments_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT,
      name TEXT NOT NULL,
      drive_folder_id TEXT,
      latitude REAL,
      longitude REAL,
      date_start TEXT,
      date_end TEXT,
      total_images INTEGER DEFAULT 0,
      total_videos INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unscanned' CHECK(status IN ('unscanned', 'scanned', 'processing', 'processed', 'verified', 'verified_empty')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by TEXT,
      project_label TEXT,
      site_name TEXT,
      odk_submission_id TEXT,
      metadata_source TEXT
    )`);
    db.exec(`INSERT INTO biochoco_deployments_new SELECT id, project_id, path, name, drive_folder_id, latitude, longitude, date_start, date_end, total_images, total_videos, status, created_at, updated_at, created_by, project_label, site_name, odk_submission_id, metadata_source FROM biochoco_deployments`);
    db.exec(`DROP TABLE biochoco_deployments`);
    db.exec(`ALTER TABLE biochoco_deployments_new RENAME TO biochoco_deployments`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_deployments_project_path ON biochoco_deployments(project_id, path)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_deployments_project_drive_folder ON biochoco_deployments(project_id, drive_folder_id)`);
    db.exec(`COMMIT`);
    console.log("  biochoco_deployments status CHECK now includes verified_empty");
  }
} catch (err) {
  try { db.exec(`ROLLBACK`); } catch { /* no active tx */ }
  console.error("Failed to migrate biochoco_deployments status constraint:", err.message);
}

// Re-enable foreign keys after table recreations
db.pragma("foreign_keys = ON");

console.log(`Schema pushed to ${fullPath}`);
console.log("Tables created:");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
for (const t of tables) {
  console.log(`  - ${t.name}`);
}

// --- Seed core projects (idempotent) ---
const coreProjects = [
  ["camera-trap", "Cámaras Trampa", "Pipeline de procesamiento de imágenes de cámaras trampa con detección y clasificación de especies"],
  ["giz", "GIZ", "Proyecto GIZ - Siembra de árboles y monitoreo de cacao"],
  ["biochoco", "BioChoco", "Programa de monitoreo de biodiversidad BioChoco"],
  ["finance", "Finanzas", "Dashboard financiero y gestión de presupuestos"],
  ["climate", "Datos Climáticos", "Datos de la estación meteorológica central de FCAT"],
  ["monitoreo", "Monitoreo Programático", "Seguimiento de actividades sociales y programáticas de FCAT"],
];

const insertProject = db.prepare(
  "INSERT OR IGNORE INTO projects (id, name, description) VALUES (?, ?, ?)"
);

let projectsAdded = 0;
for (const [id, name, desc] of coreProjects) {
  const result = insertProject.run(id, name, desc);
  if (result.changes > 0) projectsAdded++;
}

const totalProjects = db.prepare("SELECT COUNT(*) as count FROM projects").get();
console.log(`Projects: ${projectsAdded} new, ${totalProjects.count} total`);

db.close();
