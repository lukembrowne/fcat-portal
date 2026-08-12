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

// Shared Drives fan-out tables (created first so the deployments FK resolves).
const SHARED_DRIVES_DDL = `
  CREATE TABLE shared_drives (
    id TEXT PRIMARY KEY,
    drive_id TEXT NOT NULL UNIQUE,
    root_folder_id TEXT NOT NULL,
    name TEXT NOT NULL,
    camera_trap_project_id INTEGER,
    status TEXT NOT NULL DEFAULT 'registering' CHECK(status IN ('registering','active','read-only','unreachable')),
    reconciled_count INTEGER NOT NULL DEFAULT 0,
    trashed_count INTEGER NOT NULL DEFAULT 0,
    pending_reservations_count INTEGER NOT NULL DEFAULT 0,
    item_cap INTEGER NOT NULL DEFAULT 500000,
    changes_page_token TEXT,
    last_reconciled_at TEXT,
    last_full_reconcile_at TEXT,
    last_health_check_at TEXT,
    last_health_status TEXT,
    archived_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE shared_drive_reservations (
    id TEXT PRIMARY KEY,
    shared_drive_id TEXT NOT NULL REFERENCES shared_drives(id) ON DELETE RESTRICT,
    quota INTEGER NOT NULL,
    deployment_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT,
    CHECK ((released_at IS NULL) OR (released_at >= created_at))
  );

  CREATE INDEX idx_shared_drives_status_active ON shared_drives(status, archived_at);
  CREATE INDEX idx_shared_drives_project_status ON shared_drives(camera_trap_project_id, status, archived_at);
  CREATE INDEX idx_shared_drive_reservations_drive_open ON shared_drive_reservations(shared_drive_id, released_at);
`;

/**
 * Minimal in-memory DB with only the shared-drives tables, for fast unit tests
 * of the selection / reservation logic.
 */
export function createSharedDrivesTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(SHARED_DRIVES_DDL);
  return drizzle(sqlite, { schema });
}

const CAMERA_TRAP_DDL =
  SHARED_DRIVES_DDL +
  `
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
    excluded_audio INTEGER NOT NULL DEFAULT 0,
    excluded_camera INTEGER NOT NULL DEFAULT 0,
    valid_start TEXT,
    valid_end TEXT,
    qa_notes TEXT,
    field_notes TEXT,
    upload_camera_count INTEGER,
    upload_audio_count INTEGER,
    upload_ibutton_count INTEGER,
    upload_calibration_count INTEGER,
    upload_camera_folder_id TEXT,
    upload_audio_folder_id TEXT,
    upload_ibutton_folder_id TEXT,
    upload_calibration_folder_id TEXT,
    upload_counts_checked_at INTEGER,
    upload_camera_size_bytes INTEGER,
    upload_audio_size_bytes INTEGER,
    upload_ibutton_size_bytes INTEGER,
    upload_calibration_size_bytes INTEGER,
    upload_newest_camera_date TEXT,
    upload_newest_audio_date TEXT,
    upload_newest_ibutton_date TEXT,
    upload_newest_calibration_date TEXT,
    training_split TEXT,
    is_external INTEGER NOT NULL DEFAULT 0,
    previous_camera_count INTEGER,
    previous_audio_count INTEGER,
    previous_ibutton_count INTEGER,
    previous_counts_checked_at INTEGER,
    shared_drive_id TEXT REFERENCES shared_drives(id)
  );

  CREATE TABLE biochoco_processing_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    camera_trap_project_id INTEGER REFERENCES ct_projects(id) ON DELETE SET NULL,
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
    video_timestamp_method TEXT DEFAULT 'metadata',
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
    setup_tag TEXT,
    is_external INTEGER NOT NULL DEFAULT 0
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

  CREATE TABLE biochoco_external_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES biochoco_images(id) ON DELETE CASCADE,
    source_dataset TEXT NOT NULL,
    source_image_id TEXT NOT NULL,
    source_url TEXT,
    original_taxon TEXT,
    license TEXT,
    mapped_species_id INTEGER REFERENCES biochoco_species(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE biochoco_species (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scientific_name TEXT NOT NULL UNIQUE,
    common_name TEXT NOT NULL,
    spanish_name TEXT,
    taxonomic_rank TEXT NOT NULL DEFAULT 'species',
    type TEXT NOT NULL DEFAULT 'mammal',
    iucn_status TEXT,
    camera_selectable INTEGER NOT NULL DEFAULT 1,
    public_content TEXT
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

  CREATE TABLE system_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
    event_type TEXT NOT NULL,
    source TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    actor_email TEXT,
    project_id TEXT,
    target_type TEXT,
    target_id TEXT,
    summary TEXT NOT NULL,
    duration_ms INTEGER,
    details TEXT
  );

  CREATE TABLE site_share_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    biochoco_site_id TEXT NOT NULL,
    deployment_ids TEXT NOT NULL,
    hero_image_id INTEGER,
    landowner_note TEXT,
    featured_audio_id INTEGER,
    page_config TEXT,
    first_viewed_at INTEGER,
    last_viewed_at INTEGER,
    view_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    label TEXT,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX idx_site_share_tokens_site_active
    ON site_share_tokens(biochoco_site_id) WHERE revoked_at IS NULL;

  CREATE TABLE audio_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    drive_file_id TEXT,
    file_size INTEGER,
    mime_type TEXT,
    modified_at INTEGER,
    format TEXT,
    playable INTEGER NOT NULL DEFAULT 1,
    duration REAL,
    sample_rate INTEGER,
    cache_path TEXT,
    spectrogram_path TEXT,
    compressed INTEGER NOT NULL DEFAULT 0,
    original_file_size INTEGER,
    original_drive_revision_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX idx_audio_files_deployment_drive_file
    ON audio_files(deployment_id, drive_file_id);

  CREATE TABLE audio_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_file_id INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    min_freq REAL NOT NULL,
    max_freq REAL NOT NULL,
    confidence REAL,
    model_version TEXT,
    job_id INTEGER REFERENCES biochoco_processing_jobs(id) ON DELETE SET NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE audio_identifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_detection_id INTEGER NOT NULL REFERENCES audio_detections(id) ON DELETE CASCADE,
    species TEXT NOT NULL,
    confidence REAL,
    model_version TEXT,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    corrected_species TEXT,
    verified_by TEXT,
    verified_at INTEGER
  );

  CREATE TABLE acoustic_indices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_file_id INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    soundscape_saturation REAL,
    acoustic_complexity_index REAL,
    frequency_entropy REAL,
    temporal_entropy REAL,
    events_per_second REAL,
    recorded_date TEXT,
    diel_period TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    computed_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_ai_audio_file ON acoustic_indices(audio_file_id);

  CREATE TABLE occupancy_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending',
    trigger TEXT NOT NULL DEFAULT 'manual',
    bin_width_days INTEGER NOT NULL DEFAULT 5,
    audio_confidence_threshold REAL NOT NULL DEFAULT 0.7,
    thresholds_json TEXT,
    species_thresholds_json TEXT,
    n_models INTEGER NOT NULL DEFAULT 0,
    n_eligible INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    notes TEXT,
    created_by TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE occupancy_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES occupancy_runs(id) ON DELETE CASCADE,
    species TEXT NOT NULL,
    stream TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT 'combined',
    season TEXT,
    sufficient_data INTEGER NOT NULL DEFAULT 0,
    ineligible_reasons_json TEXT,
    n_sites INTEGER NOT NULL DEFAULT 0,
    n_sites_detected INTEGER NOT NULL DEFAULT 0,
    total_detections INTEGER NOT NULL DEFAULT 0,
    n_occasions INTEGER NOT NULL DEFAULT 0,
    naive_occupancy REAL,
    estimated_occupancy REAL,
    occupancy_lower REAL,
    occupancy_upper REAL,
    mean_detection REAL,
    aic REAL,
    convergence INTEGER,
    psi_formula TEXT,
    det_formula TEXT,
    fit_seconds REAL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX idx_occupancy_models_run_species_stream ON occupancy_models(run_id, species, stream, variant);
  CREATE TABLE occupancy_covariate_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES occupancy_models(id) ON DELETE CASCADE,
    submodel TEXT NOT NULL,
    param TEXT NOT NULL,
    estimate REAL NOT NULL,
    se REAL,
    z REAL,
    p_value REAL
  );
  CREATE TABLE occupancy_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES occupancy_models(id) ON DELETE CASCADE,
    artifact_path TEXT,
    grid_data_path TEXT,
    n_cells INTEGER,
    psi_min REAL,
    psi_max REAL,
    bbox_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE occupancy_site_covariates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES occupancy_runs(id) ON DELETE CASCADE,
    stream TEXT NOT NULL,
    site_id TEXT NOT NULL,
    site_name TEXT,
    latitude REAL,
    longitude REAL,
    habitat TEXT,
    elevation REAL,
    forest_cover REAL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE occupancy_public_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    label TEXT,
    created_by TEXT NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE occupancy_readiness_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bin_width_days INTEGER NOT NULL DEFAULT 5,
    audio_confidence_threshold REAL NOT NULL DEFAULT 0.7,
    result_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    generated_by TEXT,
    generated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE birdnet_validation_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    species TEXT NOT NULL,
    ct_project_id INTEGER REFERENCES ct_projects(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK(status IN ('draft','sampled','reviewing','fitted','unusable','applied','abandoned')),
    priority TEXT NOT NULL DEFAULT 'medium'
      CHECK(priority IN ('high','medium','low')),
    target_sample_size INTEGER NOT NULL DEFAULT 200,
    bin_count INTEGER NOT NULL DEFAULT 9,
    seed INTEGER NOT NULL,
    sampled_at INTEGER,
    abandoned_reason TEXT,
    notes TEXT,
    primary_reviewer_email TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX idx_birdnet_campaigns_species_scope
    ON birdnet_validation_campaigns(species, COALESCE(ct_project_id, -1))
    WHERE status != 'abandoned';
  CREATE INDEX idx_birdnet_campaigns_status ON birdnet_validation_campaigns(status);

  CREATE TABLE birdnet_validation_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES birdnet_validation_campaigns(id) ON DELETE CASCADE,
    audio_identification_id INTEGER NOT NULL REFERENCES audio_identifications(id) ON DELETE CASCADE,
    confidence REAL NOT NULL,
    bin_index INTEGER NOT NULL,
    deployment_id INTEGER,
    site_name TEXT,
    habitat TEXT,
    order_index INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_birdnet_samples_campaign_ident
    ON birdnet_validation_samples(campaign_id, audio_identification_id);
  CREATE INDEX idx_birdnet_samples_queue
    ON birdnet_validation_samples(campaign_id, order_index);

  CREATE TABLE birdnet_validation_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id INTEGER NOT NULL REFERENCES birdnet_validation_samples(id) ON DELETE CASCADE,
    reviewer_email TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('correct','incorrect','uncertain')),
    notes TEXT,
    reviewed_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX idx_birdnet_reviews_sample_reviewer
    ON birdnet_validation_reviews(sample_id, reviewer_email);
  CREATE INDEX idx_birdnet_reviews_reviewer
    ON birdnet_validation_reviews(reviewer_email, sample_id);
  CREATE INDEX idx_birdnet_reviews_sample
    ON birdnet_validation_reviews(sample_id);

  CREATE TABLE birdnet_validation_campaign_reviewers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES birdnet_validation_campaigns(id) ON DELETE CASCADE,
    reviewer_email TEXT NOT NULL,
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX idx_birdnet_campaign_reviewers_unique
    ON birdnet_validation_campaign_reviewers(campaign_id, reviewer_email);

  CREATE TABLE birdnet_species_thresholds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES birdnet_validation_campaigns(id) ON DELETE CASCADE,
    species TEXT NOT NULL,
    n_reviewed INTEGER NOT NULL,
    n_correct INTEGER NOT NULL,
    n_uncertain INTEGER NOT NULL DEFAULT 0,
    intercept REAL,
    slope REAL,
    converged INTEGER NOT NULL DEFAULT 0,
    threshold_conf_90 REAL,
    threshold_conf_95 REAL,
    threshold_conf_99 REAL,
    threshold_se_95 REAL,
    ci_lower_95 REAL,
    ci_upper_95 REAL,
    unusable_reason TEXT,
    source TEXT NOT NULL DEFAULT 'fit' CHECK(source IN ('fit', 'no_filter')),
    model_version TEXT,
    primary_reviewer_email TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    fitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    applied_at INTEGER,
    applied_by TEXT
  );
  CREATE UNIQUE INDEX idx_birdnet_thresholds_active_species
    ON birdnet_species_thresholds(species) WHERE is_active = 1;
  CREATE INDEX idx_birdnet_thresholds_campaign
    ON birdnet_species_thresholds(campaign_id);
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
