/**
 * In-memory SQLite test database for camera-trap integration tests.
 *
 * Creates a real Drizzle instance backed by :memory: SQLite with all
 * camera-trap tables. Use for testing business logic that depends on
 * actual SQL behavior (cascades, constraints, transactions).
 */

import { vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";

/**
 * Mutable ref to the current test db. Updated in beforeEach.
 * The Proxy-based @/db mock delegates all calls here at runtime.
 */
export const testDbRef: { current: any } = { current: null };

/**
 * Call at module level to register a @/db mock that proxies to testDbRef.current.
 * Uses the same delegation pattern as setupAuthMocks (vi.mock inside function).
 * Must be called before any dynamic imports of action modules.
 */
export function setupIntegrationDbMock() {
  vi.mock("@/db", () => ({
    db: new Proxy({} as any, {
      get(_, prop) {
        if (prop === "then") return undefined;
        const real = testDbRef.current;
        if (!real) throw new Error("Test db not initialized — set testDbRef.current in beforeEach");
        const val = (real as any)[prop];
        return typeof val === "function" ? val.bind(real) : val;
      },
    }),
  }));
}

const CAMERA_TRAP_DDL = `
  CREATE TABLE users (
    email TEXT PRIMARY KEY,
    name TEXT,
    is_external INTEGER NOT NULL DEFAULT 0,
    global_role TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at INTEGER
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE user_permissions (
    user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_email, project_id)
  );

  CREATE TABLE ct_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    drive_folder_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE ct_project_access (
    user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
    ct_project_id INTEGER NOT NULL REFERENCES ct_projects(id) ON DELETE CASCADE,
    PRIMARY KEY (user_email, ct_project_id)
  );

  CREATE TABLE biochoco_deployments (
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
    status TEXT NOT NULL DEFAULT 'unscanned',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_by TEXT,
    ct_project_id INTEGER REFERENCES ct_projects(id) ON DELETE SET NULL,
    project_label TEXT,
    site_name TEXT,
    odk_submission_id TEXT,
    metadata_source TEXT,
    excluded INTEGER NOT NULL DEFAULT 0,
    valid_start TEXT,
    valid_end TEXT,
    qa_notes TEXT,
    field_notes TEXT,
    upload_camera_count INTEGER,
    upload_audio_count INTEGER,
    upload_ibutton_count INTEGER,
    upload_camera_folder_id TEXT,
    upload_audio_folder_id TEXT,
    upload_ibutton_folder_id TEXT,
    upload_counts_checked_at INTEGER,
    upload_camera_size_bytes INTEGER,
    upload_audio_size_bytes INTEGER,
    upload_ibutton_size_bytes INTEGER,
    upload_newest_camera_date TEXT,
    upload_newest_audio_date TEXT,
    upload_newest_ibutton_date TEXT,
    training_split TEXT
  );

  CREATE TABLE biochoco_processing_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    detector_model TEXT,
    classifier_model TEXT,
    confidence_threshold REAL DEFAULT 0.1,
    status TEXT NOT NULL DEFAULT 'pending',
    job_type TEXT NOT NULL DEFAULT 'ml',
    pid INTEGER,
    total_images INTEGER NOT NULL DEFAULT 0,
    processed_images INTEGER NOT NULL DEFAULT 0,
    failed_images INTEGER NOT NULL DEFAULT 0,
    status_message TEXT,
    error_message TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_by TEXT,
    frame_extraction_rate REAL DEFAULT 1.0,
    total_videos INTEGER DEFAULT 0,
    extracted_frames INTEGER DEFAULT 0,
    compress_first INTEGER DEFAULT 0,
    downloaded_images INTEGER DEFAULT 0,
    download_total INTEGER DEFAULT 0,
    cached_images INTEGER DEFAULT 0
  );

  CREATE TABLE biochoco_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    drive_file_id TEXT,
    file_size INTEGER,
    file_modified INTEGER,
    path TEXT,
    duration REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT
  );

  CREATE TABLE biochoco_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES biochoco_processing_jobs(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    path TEXT,
    drive_file_id TEXT,
    file_size INTEGER,
    file_modified INTEGER,
    exif_timestamp TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    thumbnail_path TEXT,
    video_id INTEGER REFERENCES biochoco_videos(id) ON DELETE CASCADE,
    frame_index INTEGER,
    confirmed_blank INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    starred_by TEXT,
    starred_at INTEGER,
    compressed INTEGER NOT NULL DEFAULT 0,
    original_file_size INTEGER,
    setup_tag TEXT
  );

  CREATE TABLE biochoco_detections (
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
  );

  CREATE TABLE biochoco_identifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detection_id INTEGER NOT NULL REFERENCES biochoco_detections(id) ON DELETE CASCADE,
    species TEXT NOT NULL,
    confidence REAL NOT NULL,
    model_version TEXT,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    corrected_species TEXT,
    verified_by TEXT,
    verified_at INTEGER,
    classifier_model_id INTEGER
  );

  CREATE TABLE biochoco_species (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scientific_name TEXT NOT NULL UNIQUE,
    common_name TEXT NOT NULL,
    spanish_name TEXT,
    taxonomic_rank TEXT NOT NULL DEFAULT 'species',
    type TEXT NOT NULL DEFAULT 'mammal'
  );

  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    action TEXT NOT NULL,
    project_id TEXT,
    target_type TEXT,
    target_id TEXT,
    details TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

export function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(CAMERA_TRAP_DDL);

  const db = drizzle(sqlite, { schema });

  // Seed the camera-trap project
  db.insert(schema.projects)
    .values({ id: "camera-trap", name: "Cámaras Trampa" })
    .run();

  return db;
}

export type TestDb = ReturnType<typeof createTestDb>;

/**
 * Seed a deployment with images, detections, and identifications.
 * Returns IDs for use in test assertions.
 */
export function seedTestData(db: TestDb) {
  // Create a user + CT project + access for requireDeploymentAccess()
  db.insert(schema.users)
    .values({ email: "test@fcat-ecuador.org", name: "Test User" })
    .onConflictDoNothing()
    .run();

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "TestProject" })
    .returning()
    .all();

  db.insert(schema.cameraTrapProjectAccess)
    .values({ userEmail: "test@fcat-ecuador.org", cameraTrapProjectId: ctProject.id })
    .onConflictDoNothing()
    .run();

  // Create a deployment
  const [deployment] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "TEST-DEPLOY-001",
      status: "processed",
      cameraTrapProjectId: ctProject.id,
    })
    .returning()
    .all();

  // Create a job
  const [job] = db
    .insert(schema.processingJobs)
    .values({
      deploymentId: deployment.id,
      status: "completed",
      totalImages: 3,
      processedImages: 3,
    })
    .returning()
    .all();

  // Create images
  const imgRows = db
    .insert(schema.images)
    .values([
      { deploymentId: deployment.id, jobId: job.id, filename: "IMG_001.jpg", status: "processed" },
      { deploymentId: deployment.id, jobId: job.id, filename: "IMG_002.jpg", status: "processed" },
      { deploymentId: deployment.id, jobId: job.id, filename: "IMG_003.jpg", status: "processed" },
    ])
    .returning()
    .all();

  // Create detections (one per image)
  const detRows = db
    .insert(schema.detections)
    .values(
      imgRows.map((img) => ({
        imageId: img.id,
        jobId: job.id,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.5,
        bboxHeight: 0.5,
        detectionConfidence: 0.95,
        detectionClass: 0,
        modelVersion: "test-v1",
      }))
    )
    .returning()
    .all();

  // Create identifications (one per detection, all unverified)
  const identRows = db
    .insert(schema.identifications)
    .values(
      detRows.map((det) => ({
        detectionId: det.id,
        species: "Dasyprocta punctata",
        confidence: 0.88,
        modelVersion: "test-v1",
        verificationStatus: "unverified" as const,
      }))
    )
    .returning()
    .all();

  // Create some species
  const [sp1] = db
    .insert(schema.species)
    .values({
      scientificName: "Dasyprocta punctata",
      commonName: "Central American Agouti",
      spanishName: "Guatusa",
      type: "mammal",
    })
    .returning()
    .all();

  const [sp2] = db
    .insert(schema.species)
    .values({
      scientificName: "Panthera onca",
      commonName: "Jaguar",
      spanishName: "Jaguar",
      type: "mammal",
    })
    .returning()
    .all();

  return {
    ctProject,
    deployment,
    job,
    images: imgRows,
    detections: detRows,
    identifications: identRows,
    species: [sp1, sp2],
  };
}
