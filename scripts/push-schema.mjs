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

  // Deployments
  `CREATE TABLE IF NOT EXISTS deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    date_start TEXT,
    date_end TEXT,
    total_images INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unscanned' CHECK(status IN ('unscanned', 'scanned', 'processing', 'processed', 'verified')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_by TEXT
  )`,

  // Processing Jobs
  `CREATE TABLE IF NOT EXISTS processing_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
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

  // Images
  `CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES processing_jobs(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    file_size INTEGER,
    file_modified INTEGER,
    exif_timestamp TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processed', 'failed')),
    error_message TEXT,
    thumbnail_path TEXT
  )`,

  // Detections
  `CREATE TABLE IF NOT EXISTS detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
    bbox_x REAL NOT NULL,
    bbox_y REAL NOT NULL,
    bbox_width REAL NOT NULL,
    bbox_height REAL NOT NULL,
    detection_confidence REAL NOT NULL,
    detection_class INTEGER NOT NULL DEFAULT 0,
    model_version TEXT
  )`,

  // Identifications
  `CREATE TABLE IF NOT EXISTS identifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detection_id INTEGER NOT NULL REFERENCES detections(id) ON DELETE CASCADE,
    species TEXT NOT NULL,
    confidence REAL NOT NULL,
    model_version TEXT,
    verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('unverified', 'verified', 'rejected', 'corrected')),
    corrected_species TEXT,
    verified_by TEXT,
    verified_at INTEGER
  )`,

  // Species
  `CREATE TABLE IF NOT EXISTS species (
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

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_user_permissions_user_email ON user_permissions(user_email)`,
  `CREATE INDEX IF NOT EXISTS idx_user_permissions_project_id ON user_permissions(project_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_project_path ON deployments(project_id, path)`,
  `CREATE INDEX IF NOT EXISTS idx_images_deployment_id ON images(deployment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_images_job_id ON images(job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_detections_image_id ON detections(image_id)`,
  `CREATE INDEX IF NOT EXISTS idx_detections_job_id ON detections(job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_identifications_detection_id ON identifications(detection_id)`,
];

for (const stmt of statements) {
  db.exec(stmt);
}

console.log(`Schema pushed to ${fullPath}`);
console.log("Tables created:");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
for (const t of tables) {
  console.log(`  - ${t.name}`);
}

db.close();
