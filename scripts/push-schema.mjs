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
    status_message TEXT,
    job_type TEXT NOT NULL DEFAULT 'ml',
    pid INTEGER,
    total_images INTEGER NOT NULL DEFAULT 0,
    processed_images INTEGER NOT NULL DEFAULT 0,
    failed_images INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    frame_extraction_rate REAL DEFAULT 1.0,
    total_videos INTEGER DEFAULT 0,
    extracted_frames INTEGER DEFAULT 0,
    compress_first INTEGER DEFAULT 0,
    downloaded_images INTEGER DEFAULT 0,
    download_total INTEGER DEFAULT 0,
    cached_images INTEGER DEFAULT 0,
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

  // BioChoco — External Images (provenance for imported non-FCAT data, e.g. LILA)
  `CREATE TABLE IF NOT EXISTS biochoco_external_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES biochoco_images(id) ON DELETE CASCADE,
    source_dataset TEXT NOT NULL,
    source_image_id TEXT NOT NULL,
    source_url TEXT,
    original_taxon TEXT,
    license TEXT,
    mapped_species_id INTEGER REFERENCES biochoco_species(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
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

  // Camera Trap Projects (sub-projects within camera-trap module)
  `CREATE TABLE IF NOT EXISTS ct_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    drive_folder_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Camera Trap Project Access (user ↔ CT project assignments)
  `CREATE TABLE IF NOT EXISTS ct_project_access (
    user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
    ct_project_id INTEGER NOT NULL REFERENCES ct_projects(id) ON DELETE CASCADE,
    PRIMARY KEY (user_email, ct_project_id)
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

  // System Events (unified activity log across cron, admin, ingestion, jobs)
  `CREATE TABLE IF NOT EXISTS system_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
    event_type TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('admin','audio','biochoco-overview','biochoco-tools','biochoco-resultados','camera-trap','climate','cron','finance','grants','odk','shared-drives')),
    severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','success','warn','error')),
    actor_email TEXT,
    project_id TEXT,
    target_type TEXT,
    target_id TEXT,
    summary TEXT NOT NULL,
    duration_ms INTEGER,
    details TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_system_events_occurred_at ON system_events(occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_system_events_source ON system_events(source)`,
  `CREATE INDEX IF NOT EXISTS idx_system_events_event_type ON system_events(event_type)`,

  // Shared Drives — multi-drive capacity-based fan-out registry (2026-05-24)
  `CREATE TABLE IF NOT EXISTS shared_drives (
    id TEXT PRIMARY KEY,
    drive_id TEXT NOT NULL UNIQUE,
    root_folder_id TEXT NOT NULL,
    name TEXT NOT NULL,
    camera_trap_project_id INTEGER REFERENCES ct_projects(id),
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
  )`,
  `CREATE TABLE IF NOT EXISTS shared_drive_reservations (
    id TEXT PRIMARY KEY,
    shared_drive_id TEXT NOT NULL REFERENCES shared_drives(id) ON DELETE RESTRICT,
    quota INTEGER NOT NULL,
    deployment_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT,
    CHECK ((released_at IS NULL) OR (released_at >= created_at))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shared_drives_status_active ON shared_drives(status, archived_at)`,
  // NOTE: idx_shared_drives_project_status is created in postMigrationIndexes —
  // the camera_trap_project_id column is added by an ALTER migration, which runs
  // AFTER this block, so the index can't be created here for existing DBs.
  `CREATE INDEX IF NOT EXISTS idx_shared_drive_reservations_drive_open ON shared_drive_reservations(shared_drive_id, released_at)`,

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
    qc_flags TEXT,
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

  // iButton — Uploads (tracking processed iButton files per deployment)
  `CREATE TABLE IF NOT EXISTS ibutton_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL UNIQUE REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    device_serial TEXT,
    sample_rate TEXT,
    mission_start TEXT,
    rows_imported INTEGER NOT NULL,
    date_range_start TEXT,
    date_range_end TEXT,
    processed_by TEXT NOT NULL,
    processed_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // iButton — Readings (individual temperature measurements)
  `CREATE TABLE IF NOT EXISTS ibutton_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    upload_id INTEGER NOT NULL REFERENCES ibutton_uploads(id) ON DELETE CASCADE,
    timestamp TEXT NOT NULL,
    temperature_c REAL NOT NULL,
    flagged INTEGER NOT NULL DEFAULT 0,
    UNIQUE(deployment_id, timestamp)
  )`,

  // iButton indexes
  `CREATE INDEX IF NOT EXISTS idx_ibutton_readings_dep ON ibutton_readings(deployment_id)`,

  // Audio Files (passive audio recorder recordings)
  `CREATE TABLE IF NOT EXISTS audio_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    drive_file_id TEXT,
    file_size INTEGER,
    mime_type TEXT,
    modified_at INTEGER,
    format TEXT,
    playable INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Audio Files indexes
  `CREATE INDEX IF NOT EXISTS idx_audio_files_deployment_id ON audio_files(deployment_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_files_deployment_drive_file ON audio_files(deployment_id, drive_file_id)`,

  // Audio Detections (time-frequency bounding boxes on spectrograms)
  `CREATE TABLE IF NOT EXISTS audio_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_file_id INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    min_freq REAL NOT NULL,
    max_freq REAL NOT NULL,
    confidence REAL,
    model_version TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audio_detections_file ON audio_detections(audio_file_id)`,

  // Audio Identifications (species labels for audio detections)
  `CREATE TABLE IF NOT EXISTS audio_identifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_detection_id INTEGER NOT NULL REFERENCES audio_detections(id) ON DELETE CASCADE,
    species TEXT NOT NULL,
    confidence REAL,
    model_version TEXT,
    verification_status TEXT NOT NULL DEFAULT 'unverified'
      CHECK(verification_status IN ('unverified','verified','rejected','corrected')),
    corrected_species TEXT,
    verified_by TEXT,
    verified_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audio_identifications_detection ON audio_identifications(audio_detection_id)`,

  // Acoustic Indices (Müller 2023 / Kümmet 2025 five-index recipe per audio file)
  `CREATE TABLE IF NOT EXISTS acoustic_indices (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_audio_file ON acoustic_indices(audio_file_id)`,

  // Occupancy modeling (single-season single-species via unmarked::occu).
  // See src/db/schema.ts + docs/brainstorms/2026-07-03-occupancy-modeling-requirements.md
  `CREATE TABLE IF NOT EXISTS occupancy_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
    trigger TEXT NOT NULL DEFAULT 'manual' CHECK(trigger IN ('cron','manual')),
    bin_width_days INTEGER NOT NULL DEFAULT 5,
    audio_confidence_threshold REAL NOT NULL DEFAULT 0.7,
    thresholds_json TEXT,
    n_models INTEGER NOT NULL DEFAULT 0,
    n_eligible INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    notes TEXT,
    created_by TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_occupancy_runs_status ON occupancy_runs(status)`,
  `CREATE TABLE IF NOT EXISTS occupancy_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES occupancy_runs(id) ON DELETE CASCADE,
    species TEXT NOT NULL,
    stream TEXT NOT NULL CHECK(stream IN ('camera','audio')),
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
    dropped_covariates_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_occupancy_models_run_species_stream ON occupancy_models(run_id, species, stream, variant)`,
  `CREATE INDEX IF NOT EXISTS idx_occupancy_models_species ON occupancy_models(species)`,
  `CREATE INDEX IF NOT EXISTS idx_occupancy_models_stream ON occupancy_models(stream)`,
  `CREATE TABLE IF NOT EXISTS occupancy_covariate_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES occupancy_models(id) ON DELETE CASCADE,
    submodel TEXT NOT NULL CHECK(submodel IN ('state','det')),
    param TEXT NOT NULL,
    estimate REAL NOT NULL,
    se REAL,
    z REAL,
    p_value REAL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_occupancy_effects_model ON occupancy_covariate_effects(model_id)`,
  `CREATE TABLE IF NOT EXISTS occupancy_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES occupancy_models(id) ON DELETE CASCADE,
    artifact_path TEXT,
    grid_data_path TEXT,
    n_cells INTEGER,
    psi_min REAL,
    psi_max REAL,
    bbox_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_occupancy_predictions_model ON occupancy_predictions(model_id)`,
  `CREATE TABLE IF NOT EXISTS occupancy_site_covariates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES occupancy_runs(id) ON DELETE CASCADE,
    stream TEXT NOT NULL CHECK(stream IN ('camera','audio')),
    site_id TEXT NOT NULL,
    site_name TEXT,
    latitude REAL,
    longitude REAL,
    habitat TEXT,
    elevation REAL,
    forest_cover REAL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_occupancy_site_covariates_run ON occupancy_site_covariates(run_id, stream)`,
  `CREATE TABLE IF NOT EXISTS occupancy_public_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    label TEXT,
    created_by TEXT NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_occupancy_public_tokens_token ON occupancy_public_tokens(token)`,
  // Readiness snapshots: cached /ocupacion data-readiness report (JSON blob) +
  // a cheap data fingerprint, so the page renders instantly instead of
  // recomputing the full report on every load. Always inserted (never upserted);
  // reads take the latest by generated_at for a given config.
  `CREATE TABLE IF NOT EXISTS occupancy_readiness_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bin_width_days INTEGER NOT NULL DEFAULT 5,
    audio_confidence_threshold REAL NOT NULL DEFAULT 0.7,
    result_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    generated_by TEXT,
    generated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_occupancy_readiness_snapshots_config ON occupancy_readiness_snapshots(bin_width_days, audio_confidence_threshold, generated_at)`,

  // Upload Count Snapshots (daily aggregate of Drive upload counts)
  `CREATE TABLE IF NOT EXISTS upload_count_snapshots (
    date TEXT PRIMARY KEY,
    total_cameras INTEGER NOT NULL DEFAULT 0,
    total_audio INTEGER NOT NULL DEFAULT 0,
    total_ibutton INTEGER NOT NULL DEFAULT 0,
    deployments_with_uploads INTEGER NOT NULL DEFAULT 0,
    total_deployments INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Share Tokens (public share links for camera trap deployments)
  `CREATE TABLE IF NOT EXISTS share_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    deployment_id INTEGER NOT NULL REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    label TEXT,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_share_tokens_token ON share_tokens(token)`,
  `CREATE INDEX IF NOT EXISTS idx_share_tokens_deployment ON share_tokens(deployment_id)`,

  // Site Share Tokens (public share links for biochoco site results pages)
  // Aggregates camera trap deployments + habitat + temperature for one site.
  // deployment_ids is materialized as a JSON array at creation time.
  // The unique partial index enforces one active token per site.
  `CREATE TABLE IF NOT EXISTS site_share_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    biochoco_site_id TEXT NOT NULL,
    deployment_ids TEXT NOT NULL,
    hero_image_id INTEGER,
    created_by TEXT NOT NULL,
    label TEXT,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_site_share_tokens_token ON site_share_tokens(token)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_share_tokens_site_active
    ON site_share_tokens(biochoco_site_id) WHERE revoked_at IS NULL`,

  // App State (generic key/value for cross-module timestamps/flags)
  `CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Camera Trap — Training Datasets (versioned exports for custom classifier)
  `CREATE TABLE IF NOT EXISTS camera_trap_training_datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_by TEXT NOT NULL,
    image_count INTEGER NOT NULL,
    class_count INTEGER NOT NULL,
    min_examples_threshold INTEGER NOT NULL,
    class_list_json TEXT NOT NULL,
    dropped_species_json TEXT NOT NULL,
    deployments_json TEXT NOT NULL,
    manifest_path TEXT NOT NULL,
    detection_confidence_floor REAL,
    crop_padding REAL,
    crop_long_edge INTEGER,
    jpeg_quality INTEGER,
    drive_archive_file_id TEXT,
    drive_archive_web_view_link TEXT,
    archive_uploaded_at INTEGER
  )`,

  // Camera Trap — Models (registered custom classifier weights)
  `CREATE TABLE IF NOT EXISTS camera_trap_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    model_dir TEXT NOT NULL,
    class_mapping_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    confidence_threshold REAL NOT NULL,
    training_dataset_id INTEGER REFERENCES camera_trap_training_datasets(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_by TEXT NOT NULL
  )`,
  // Partial unique index — at most one active model
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_camera_trap_models_active ON camera_trap_models(active) WHERE active = 1`,

  // Camera Trap — Per-class metrics (2026-05-22, one row per model × class)
  // CASCADE: rows are derived data, meaningless without parent model.
  `CREATE TABLE IF NOT EXISTS camera_trap_model_class_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES camera_trap_models(id) ON DELETE CASCADE,
    class_name TEXT NOT NULL,
    precision_value REAL,
    recall REAL,
    f1 REAL,
    support INTEGER NOT NULL,
    train_count INTEGER
  )`,
  // Composite unique covers the leading-prefix WHERE model_id = ? case;
  // no standalone byModel / byClass index needed.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ct_mcm_model_class ON camera_trap_model_class_metrics(model_id, class_name)`,

  // --- Researcher Applications ---
  `CREATE TABLE IF NOT EXISTS research_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT,
    reference_code TEXT,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','under_review','accepted','rejected','revisions_requested')),
    project_title TEXT NOT NULL,
    pi_full_name TEXT NOT NULL,
    pi_email TEXT NOT NULL,
    pi_phone TEXT,
    pi_institution TEXT,
    collaborators TEXT,
    project_start_date TEXT,
    project_end_date TEXT,
    project_goals TEXT,
    methods TEXT,
    samples_details TEXT,
    genetic_resources TEXT,
    needs_fcat_assistance INTEGER NOT NULL DEFAULT 0,
    facilities_needs TEXT,
    permanent_equipment TEXT,
    personnel_collaboration TEXT,
    community_engagement TEXT,
    data_sharing TEXT,
    code_of_conduct_agreed INTEGER NOT NULL DEFAULT 0,
    guidelines_agreed INTEGER NOT NULL DEFAULT 0,
    permits_status TEXT,
    drive_folder_id TEXT,
    drive_files_json TEXT,
    primary_reviewer_email TEXT,
    decision_notes TEXT,
    final_report_due_date TEXT,
    report_submit_token TEXT,
    report_submit_token_expires_at TEXT,
    reminder_30_sent_at INTEGER,
    reminder_0_sent_at INTEGER,
    reminder_overdue_sent_at INTEGER,
    decision_email_sent_at INTEGER,
    submitter_ip TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    decided_at INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_research_apps_external_id ON research_applications(external_id) WHERE external_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_research_apps_reference_code ON research_applications(reference_code) WHERE reference_code IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_research_apps_status_created ON research_applications(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_research_apps_pi_email ON research_applications(pi_email)`,

  `CREATE TABLE IF NOT EXISTS research_application_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES research_applications(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_research_refs_app_id ON research_application_references(application_id)`,

  `CREATE TABLE IF NOT EXISTS research_application_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES research_applications(id) ON DELETE CASCADE,
    author_email TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_research_comments_app_id_created ON research_application_comments(application_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS research_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES research_applications(id) ON DELETE CASCADE,
    summary TEXT,
    drive_files_json TEXT,
    submitter_ip TEXT,
    submitted_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_research_reports_app_id ON research_reports(application_id)`,

  // Grant Tracking (Seguimiento de Subsidios) — funders first (FK parent of grants)
  `CREATE TABLE IF NOT EXISTS funders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_normalized TEXT NOT NULL,
    website TEXT,
    priority TEXT CHECK(priority IN ('highest','high','medium','low')),
    funder_type TEXT,
    focus_areas TEXT,
    relationship_manager TEXT,
    relationship_status TEXT,
    next_steps TEXT,
    next_step_due INTEGER,
    contact_name TEXT,
    contact_email TEXT,
    funding_history TEXT,
    description TEXT,
    notes TEXT,
    irs990_link TEXT,
    guidestar_link TEXT,
    foundation_directory_link TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_funders_name_normalized ON funders(name_normalized)`,
  `CREATE INDEX IF NOT EXISTS idx_funders_priority_name ON funders(priority, name)`,

  `CREATE TABLE IF NOT EXISTS grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    funder_id INTEGER REFERENCES funders(id) ON DELETE SET NULL,
    funder_name_raw TEXT,
    name TEXT NOT NULL,
    website TEXT,
    status TEXT NOT NULL DEFAULT 'to_research' CHECK(status IN ('to_research','in_prep','pending_decision','funded','rejected','passed','completed')),
    amount_requested REAL,
    amount_awarded REAL,
    due_date INTEGER,
    last_notified_at INTEGER,
    reminders_sent INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    folder_link TEXT,
    budget_link TEXT,
    proposal_link TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_grants_status_due ON grants(status, due_date)`,
  `CREATE INDEX IF NOT EXISTS idx_grants_funder ON grants(funder_id)`,

  // Public Report Snapshots (published payload for public/* overview pages).
  // One row per slug; upserted by the admin publish action.
  `CREATE TABLE IF NOT EXISTS public_report_snapshots (
    slug TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    generated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    generated_by TEXT
  )`,
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
  // Camera trap project-level permissions (2026-02-22)
  `ALTER TABLE biochoco_deployments ADD COLUMN ct_project_id INTEGER REFERENCES ct_projects(id) ON DELETE SET NULL`,
  // Deployment QA metadata (2026-02-23)
  // Per-stream exclusion (2026-07-16): replaced the single `excluded` flag with
  // excluded_audio + excluded_camera. Existing prod DBs keep their `excluded`
  // column until scripts/migrate-split-exclusion.mjs backfills + drops it; new
  // DBs never create it. These ALTERs are idempotent (already-exists is ignored).
  `ALTER TABLE biochoco_deployments ADD COLUMN excluded_audio INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE biochoco_deployments ADD COLUMN excluded_camera INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE biochoco_deployments ADD COLUMN valid_start TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN valid_end TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN qa_notes TEXT`,
  // Upload cache — Drive file counts (2026-02-24)
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_camera_count INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_audio_count INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_ibutton_count INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_camera_folder_id TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_audio_folder_id TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_ibutton_folder_id TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_counts_checked_at INTEGER`,
  // Audio annotation — new columns on audio_files (2026-02-25)
  `ALTER TABLE audio_files ADD COLUMN duration REAL`,
  `ALTER TABLE audio_files ADD COLUMN sample_rate INTEGER`,
  `ALTER TABLE audio_files ADD COLUMN cache_path TEXT`,
  `ALTER TABLE audio_files ADD COLUMN spectrogram_path TEXT`,
  // Image compression tracking (2026-02-28)
  `ALTER TABLE biochoco_images ADD COLUMN compressed INTEGER NOT NULL DEFAULT 0`,
  // Job type column for compression vs ML jobs (2026-03-02)
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'ml'`,
  // Original file size for compression revert (2026-03-02)
  `ALTER TABLE biochoco_images ADD COLUMN original_file_size INTEGER`,
  // Optional compression before ML processing (2026-03-02)
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN compress_first INTEGER DEFAULT 0`,
  // Setup tag for deployment/retrieval images (2026-03-03)
  `ALTER TABLE biochoco_images ADD COLUMN setup_tag TEXT`,
  // Download progress tracking (2026-03-04)
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN downloaded_images INTEGER DEFAULT 0`,
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN download_total INTEGER DEFAULT 0`,
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN cached_images INTEGER DEFAULT 0`,
  // Upload cache — file sizes and newest dates (2026-04-02)
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_camera_size_bytes INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_audio_size_bytes INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_ibutton_size_bytes INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_newest_camera_date TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_newest_audio_date TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_newest_ibutton_date TEXT`,
  // Audio-calibration subfolder — counted on the datos page only (2026-06-17)
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_calibration_count INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_calibration_folder_id TEXT`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_calibration_size_bytes INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN upload_newest_calibration_date TEXT`,
  // Upload snapshots — size tracking (2026-04-02)
  `ALTER TABLE upload_count_snapshots ADD COLUMN total_camera_size_bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE upload_count_snapshots ADD COLUMN total_audio_size_bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE upload_count_snapshots ADD COLUMN total_ibutton_size_bytes INTEGER NOT NULL DEFAULT 0`,
  // Deployment field notes — operational context (2026-04-04)
  `ALTER TABLE biochoco_deployments ADD COLUMN field_notes TEXT`,
  // Custom classifier training infrastructure (2026-04-08)
  `ALTER TABLE biochoco_deployments ADD COLUMN training_split TEXT`,
  `ALTER TABLE biochoco_identifications ADD COLUMN classifier_model_id INTEGER REFERENCES camera_trap_models(id) ON DELETE SET NULL`,
  // Video timestamp method — how to derive capture time for extracted frames (2026-04-12)
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN video_timestamp_method TEXT DEFAULT 'metadata'`,
  // BirdNET integration — add job_id to audio_detections (2026-04-13)
  `ALTER TABLE audio_detections ADD COLUMN job_id INTEGER REFERENCES biochoco_processing_jobs(id) ON DELETE SET NULL`,
  // Per-deployment previous upload counts — for nightly email deltas (2026-05-06)
  `ALTER TABLE biochoco_deployments ADD COLUMN previous_camera_count INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN previous_audio_count INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN previous_ibutton_count INTEGER`,
  `ALTER TABLE biochoco_deployments ADD COLUMN previous_counts_checked_at INTEGER`,
  // Drive sync background job: scope to a CT project (nullable) (2026-05-06)
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN camera_trap_project_id INTEGER REFERENCES ct_projects(id) ON DELETE SET NULL`,
  // Audio WAV→FLAC compression tracking (2026-05-11)
  // `compressed=true` is set for both successful FLAC encodes and non_compressible
  // WAVs left as-is. `original_drive_revision_id` is the Drive revision captured
  // immediately before replacement — the anchor used by the revert job.
  `ALTER TABLE audio_files ADD COLUMN compressed INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE audio_files ADD COLUMN original_file_size INTEGER`,
  `ALTER TABLE audio_files ADD COLUMN original_drive_revision_id TEXT`,
  // Per-model confusion matrix JSON (2026-05-22)
  // { classes, matrix, axisConvention }. Nullable for legacy v1 models.
  `ALTER TABLE camera_trap_models ADD COLUMN confusion_matrix_json TEXT`,
  // Multi-shared-drive fan-out: which Shared Drive hosts a deployment (2026-05-24)
  // Nullable FK; ON DELETE RESTRICT so admin deletes can't orphan rows.
  `ALTER TABLE biochoco_deployments ADD COLUMN shared_drive_id TEXT REFERENCES shared_drives(id) ON DELETE RESTRICT`,
  // Project-scoped fan-out: which project a Shared Drive serves (2026-05-27).
  // One project per drive — routing + discovery are scoped to this.
  `ALTER TABLE shared_drives ADD COLUMN camera_trap_project_id INTEGER REFERENCES ct_projects(id)`,
  // Trash now counts toward reconciled_count (matches Google's cap); track the
  // purgeable subset separately for the admin UI (2026-06-17).
  `ALTER TABLE shared_drives ADD COLUMN trashed_count INTEGER NOT NULL DEFAULT 0`,
  // Training-export crop-quality knobs + Drive archive sharing (2026-05-28).
  `ALTER TABLE camera_trap_training_datasets ADD COLUMN detection_confidence_floor REAL`,
  `ALTER TABLE camera_trap_training_datasets ADD COLUMN crop_padding REAL`,
  `ALTER TABLE camera_trap_training_datasets ADD COLUMN crop_long_edge INTEGER`,
  `ALTER TABLE camera_trap_training_datasets ADD COLUMN jpeg_quality INTEGER`,
  `ALTER TABLE camera_trap_training_datasets ADD COLUMN drive_archive_file_id TEXT`,
  `ALTER TABLE camera_trap_training_datasets ADD COLUMN drive_archive_web_view_link TEXT`,
  `ALTER TABLE camera_trap_training_datasets ADD COLUMN archive_uploaded_at INTEGER`,

  // External-image provenance flags — LILA import (2026-06-29).
  `ALTER TABLE biochoco_deployments ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE biochoco_images ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0`,
  // Per-source export totals surfaced in the history table (2026-06-29).
  `ALTER TABLE camera_trap_training_datasets ADD COLUMN fcat_image_count INTEGER`,
  `ALTER TABLE camera_trap_training_datasets ADD COLUMN external_image_count INTEGER`,

  // Climate — per-cell QC flag provenance (raw value + reason, sparse JSON)
  `ALTER TABLE climate_readings ADD COLUMN qc_flags TEXT`,

  // Grants — two-tier automatic reminders (30 + 14 days) replace the per-grant
  // notify window; RFP-check date was inert. Drop both columns, add the counter
  // (2026-06-23). DROP COLUMN needs SQLite ≥3.35 (better-sqlite3 ships it).
  `ALTER TABLE grants ADD COLUMN reminders_sent INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE grants DROP COLUMN check_rfp_date`,
  `ALTER TABLE grants DROP COLUMN notify_before_days`,

  // Occupancy: per-model covariate-drop reasons so a reduced (ψ~1) model is
  // visibly reduced instead of silently fitting an intercept-only null (2026-07-13)
  `ALTER TABLE occupancy_models ADD COLUMN dropped_covariates_json TEXT`,

  // Occupancy: split one ψ model into two variants per species×stream — 'geo'
  // (ψ~forest+elevation) and 'habitat' (ψ~habitat). Existing rows become the
  // legacy 'combined'. The unique index gains `variant` below in
  // postMigrationIndexes (DROP the 3-col, recreate 4-col) (2026-07-13).
  `ALTER TABLE occupancy_models ADD COLUMN variant TEXT NOT NULL DEFAULT 'combined'`,

  // Landowner dashboard: IUCN Red List category for conservation/rarity badges.
  // Bare TEXT (no CHECK) to avoid a table rebuild; populated by
  // scripts/backfill-iucn-status.mjs (2026-07-14).
  `ALTER TABLE biochoco_species ADD COLUMN iucn_status TEXT`,

  // Landowner dashboard: per-site personalization on the public share page —
  // a free-text note and one curated "example recording" audio clip. Both
  // nullable; edited in the internal share popover. Seeds of the page-builder
  // (2026-07-15).
  `ALTER TABLE site_share_tokens ADD COLUMN landowner_note TEXT`,
  `ALTER TABLE site_share_tokens ADD COLUMN featured_audio_id INTEGER`,

  // Landowner dashboard: per-site page-builder config (ordered JSON blocks).
  // Null → default layout. See src/lib/landowner/page-config.ts (2026-07-15).
  `ALTER TABLE site_share_tokens ADD COLUMN page_config TEXT`,

  // Landowner dashboard: lightweight view tracking on the public share page —
  // first/last opened timestamps (Unix seconds, nullable) + a running view
  // count. Stamped by recordSiteView() on public page render (2026-07-16).
  `ALTER TABLE site_share_tokens ADD COLUMN first_viewed_at INTEGER`,
  `ALTER TABLE site_share_tokens ADD COLUMN last_viewed_at INTEGER`,
  `ALTER TABLE site_share_tokens ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0`,

  // Species: whether offered in the camera-trap annotation picker. Default 1
  // keeps every existing curated species selectable; the BirdNET taxonomy
  // import + per-run auto-add set it to 0 for audio-only birds so the label
  // set doesn't flood the annotation dropdown. Name/IUCN resolution ignores
  // this flag; only getSpeciesList() filters on it (2026-07-16).
  `ALTER TABLE biochoco_species ADD COLUMN camera_selectable INTEGER NOT NULL DEFAULT 1`,
];
for (const m of migrations) {
  try { db.exec(m); } catch { /* column already exists */ }
}

// --- Post-migration indexes (depend on columns added by migrations) ---
const postMigrationIndexes = [
  `CREATE INDEX IF NOT EXISTS idx_biochoco_images_starred ON biochoco_images(starred) WHERE starred = 1`,
  `CREATE INDEX IF NOT EXISTS idx_audio_detections_job ON audio_detections(job_id)`,

  // External-image provenance lookups + idempotency (LILA import) (2026-06-29)
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_external_images_image_id ON biochoco_external_images(image_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_biochoco_external_images_source ON biochoco_external_images(source_dataset, source_image_id)`,
  `CREATE INDEX IF NOT EXISTS idx_biochoco_external_images_dataset ON biochoco_external_images(source_dataset)`,

  // Species detection browser — partial indexes for effective-species aggregation.
  // Split the active vs. corrected branches so each gets a sargable predicate
  // hitting its own small index. See src/db/effective-species.ts.
  `CREATE INDEX IF NOT EXISTS idx_bio_id_species_active
    ON biochoco_identifications(species, detection_id)
    WHERE verification_status IN ('unverified','verified')`,
  `CREATE INDEX IF NOT EXISTS idx_bio_id_corrected
    ON biochoco_identifications(corrected_species, detection_id)
    WHERE verification_status = 'corrected'`,
  `CREATE INDEX IF NOT EXISTS idx_audio_id_species_active
    ON audio_identifications(species, audio_detection_id)
    WHERE verification_status IN ('unverified','verified')`,
  `CREATE INDEX IF NOT EXISTS idx_audio_id_corrected
    ON audio_identifications(corrected_species, audio_detection_id)
    WHERE verification_status = 'corrected'`,
  // Occupancy: fold `variant` into the per-model uniqueness so two variants
  // (geo + habitat) coexist per species×stream. Drop the legacy 3-col index and
  // recreate 4-col; existing rows are all 'combined' so uniqueness still holds
  // (2026-07-13).
  `DROP INDEX IF EXISTS idx_occupancy_models_run_species_stream`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_occupancy_models_run_species_stream ON occupancy_models(run_id, species, stream, variant)`,
  // Occupancy: rename the 'geo' ψ variant to the clearer 'gradient' in place
  // (ψ~forest+elevation). No CHECK constraint on `variant`, so a plain UPDATE
  // suffices — idempotent (matches nothing after the first run). New runs write
  // 'gradient'/'null' directly (2026-07-14).
  `UPDATE occupancy_models SET variant = 'gradient' WHERE variant = 'geo'`,
  // Multi-shared-drive fan-out: index the deployment → drive FK (2026-05-24)
  `CREATE INDEX IF NOT EXISTS idx_biochoco_deployments_shared_drive_id ON biochoco_deployments(shared_drive_id)`,
  // Project-scoped fan-out: selection hot path (2026-05-27)
  `CREATE INDEX IF NOT EXISTS idx_shared_drives_project_status ON shared_drives(camera_trap_project_id, status, archived_at)`,
];
for (const idx of postMigrationIndexes) {
  db.exec(idx);
}

// Backfill shared_drives.camera_trap_project_id by matching a drive's root
// folder to a project's root folder (idempotent; only fills NULLs). A drive
// registered at a project's own root belongs to that project. Drives whose
// root is a bare drive root match nothing and stay NULL until assigned in the
// admin UI (and are simply never selected by routing/discovery while NULL).
try {
  db.exec(`
    UPDATE shared_drives
    SET camera_trap_project_id = (
      SELECT p.id FROM ct_projects p
      WHERE p.drive_folder_id = shared_drives.root_folder_id
    )
    WHERE camera_trap_project_id IS NULL
      AND EXISTS (
        SELECT 1 FROM ct_projects p
        WHERE p.drive_folder_id = shared_drives.root_folder_id
      )
  `);
} catch { /* table/columns may not exist on a partial schema */ }

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

// --- Table recreation: make biochoco_processing_jobs.deployment_id nullable (2026-05-06) ---
// drive_sync jobs span many deployments and have no single deploymentId.
try {
  const depIdInfo = db
    .prepare(`SELECT "notnull" FROM pragma_table_info('biochoco_processing_jobs') WHERE name = 'deployment_id'`)
    .get();
  if (depIdInfo && depIdInfo.notnull === 1) {
    console.log("Migrating biochoco_processing_jobs table: making deployment_id nullable...");
    db.exec(`BEGIN TRANSACTION`);
    db.exec(`CREATE TABLE biochoco_processing_jobs_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id INTEGER REFERENCES biochoco_deployments(id) ON DELETE CASCADE,
      camera_trap_project_id INTEGER REFERENCES ct_projects(id) ON DELETE SET NULL,
      detector_model TEXT,
      classifier_model TEXT,
      confidence_threshold REAL DEFAULT 0.1,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
      status_message TEXT,
      job_type TEXT NOT NULL DEFAULT 'ml',
      pid INTEGER,
      total_images INTEGER NOT NULL DEFAULT 0,
      processed_images INTEGER NOT NULL DEFAULT 0,
      failed_images INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      frame_extraction_rate REAL DEFAULT 1.0,
      total_videos INTEGER DEFAULT 0,
      extracted_frames INTEGER DEFAULT 0,
      compress_first INTEGER DEFAULT 0,
      video_timestamp_method TEXT DEFAULT 'metadata',
      downloaded_images INTEGER DEFAULT 0,
      download_total INTEGER DEFAULT 0,
      cached_images INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by TEXT
    )`);
    // Copy all rows preserving every value; new column camera_trap_project_id
    // already existed before this migration (see ALTER above) so it's in the
    // source table too.
    db.exec(`
      INSERT INTO biochoco_processing_jobs_new (
        id, deployment_id, camera_trap_project_id, detector_model, classifier_model,
        confidence_threshold, status, status_message, job_type, pid,
        total_images, processed_images, failed_images, error_message,
        started_at, completed_at, frame_extraction_rate, total_videos,
        extracted_frames, compress_first, video_timestamp_method,
        downloaded_images, download_total, cached_images, created_at, created_by
      )
      SELECT
        id, deployment_id, camera_trap_project_id, detector_model, classifier_model,
        confidence_threshold, status, status_message, job_type, pid,
        total_images, processed_images, failed_images, error_message,
        started_at, completed_at, frame_extraction_rate, total_videos,
        extracted_frames, compress_first, video_timestamp_method,
        downloaded_images, download_total, cached_images, created_at, created_by
      FROM biochoco_processing_jobs
    `);
    db.exec(`DROP TABLE biochoco_processing_jobs`);
    db.exec(`ALTER TABLE biochoco_processing_jobs_new RENAME TO biochoco_processing_jobs`);
    db.exec(`COMMIT`);
    console.log("  biochoco_processing_jobs.deployment_id is now nullable");
  }
} catch (err) {
  try { db.exec(`ROLLBACK`); } catch { /* no active tx */ }
  console.error("Failed to migrate biochoco_processing_jobs.deployment_id:", err.message);
}

// --- Table recreation: add biochoco-overview to system_events.source CHECK (2026-05-18) ---
try {
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='system_events'")
    .get();
  if (tableInfo && !tableInfo.sql.includes("biochoco-overview")) {
    console.log("Migrating system_events table: adding biochoco-overview to source CHECK...");
    db.exec(`BEGIN TRANSACTION`);
    db.exec(`CREATE TABLE system_events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
      event_type TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('admin','audio','biochoco-overview','biochoco-tools','biochoco-resultados','camera-trap','climate','cron','finance','odk')),
      severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','success','warn','error')),
      actor_email TEXT,
      project_id TEXT,
      target_type TEXT,
      target_id TEXT,
      summary TEXT NOT NULL,
      duration_ms INTEGER,
      details TEXT
    )`);
    db.exec(`INSERT INTO system_events_new SELECT id, occurred_at, event_type, source, severity, actor_email, project_id, target_type, target_id, summary, duration_ms, details FROM system_events`);
    db.exec(`DROP TABLE system_events`);
    db.exec(`ALTER TABLE system_events_new RENAME TO system_events`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_events_occurred_at ON system_events(occurred_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_events_source ON system_events(source)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_events_event_type ON system_events(event_type)`);
    db.exec(`COMMIT`);
    console.log("  system_events.source CHECK now includes biochoco-overview");
  }
} catch (err) {
  try { db.exec(`ROLLBACK`); } catch { /* no active tx */ }
  console.error("Failed to migrate system_events source constraint:", err.message);
}

// --- Table recreation: add shared-drives to system_events.source CHECK (2026-05-24) ---
try {
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='system_events'")
    .get();
  if (tableInfo && !tableInfo.sql.includes("shared-drives")) {
    console.log("Migrating system_events table: adding shared-drives to source CHECK...");
    db.exec(`BEGIN TRANSACTION`);
    db.exec(`CREATE TABLE system_events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
      event_type TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('admin','audio','biochoco-overview','biochoco-tools','biochoco-resultados','camera-trap','climate','cron','finance','odk','shared-drives')),
      severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','success','warn','error')),
      actor_email TEXT,
      project_id TEXT,
      target_type TEXT,
      target_id TEXT,
      summary TEXT NOT NULL,
      duration_ms INTEGER,
      details TEXT
    )`);
    db.exec(`INSERT INTO system_events_new SELECT id, occurred_at, event_type, source, severity, actor_email, project_id, target_type, target_id, summary, duration_ms, details FROM system_events`);
    db.exec(`DROP TABLE system_events`);
    db.exec(`ALTER TABLE system_events_new RENAME TO system_events`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_events_occurred_at ON system_events(occurred_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_events_source ON system_events(source)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_events_event_type ON system_events(event_type)`);
    db.exec(`COMMIT`);
    console.log("  system_events.source CHECK now includes shared-drives");
  }
} catch (err) {
  try { db.exec(`ROLLBACK`); } catch { /* no active tx */ }
  console.error("Failed to migrate system_events source constraint (shared-drives):", err.message);
}

// --- Table recreation: add grants to system_events.source CHECK (2026-06-22) ---
// recordEvent() swallows CHECK violations silently, so this MUST run on existing
// prod DBs or grant audit events would vanish without error.
try {
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='system_events'")
    .get();
  if (tableInfo && !tableInfo.sql.includes("'grants'")) {
    console.log("Migrating system_events table: adding grants to source CHECK...");
    db.exec(`BEGIN TRANSACTION`);
    db.exec(`CREATE TABLE system_events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
      event_type TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('admin','audio','biochoco-overview','biochoco-tools','biochoco-resultados','camera-trap','climate','cron','finance','grants','odk','shared-drives')),
      severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','success','warn','error')),
      actor_email TEXT,
      project_id TEXT,
      target_type TEXT,
      target_id TEXT,
      summary TEXT NOT NULL,
      duration_ms INTEGER,
      details TEXT
    )`);
    db.exec(`INSERT INTO system_events_new SELECT id, occurred_at, event_type, source, severity, actor_email, project_id, target_type, target_id, summary, duration_ms, details FROM system_events`);
    db.exec(`DROP TABLE system_events`);
    db.exec(`ALTER TABLE system_events_new RENAME TO system_events`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_events_occurred_at ON system_events(occurred_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_events_source ON system_events(source)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_events_event_type ON system_events(event_type)`);
    db.exec(`COMMIT`);
    console.log("  system_events.source CHECK now includes grants");
  }
} catch (err) {
  try { db.exec(`ROLLBACK`); } catch { /* no active tx */ }
  console.error("Failed to migrate system_events source constraint (grants):", err.message);
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
  ["grabaciones", "Grabaciones", "Grabaciones de audio y detección de especies acústicas"],
  ["researcher-applications", "Aplicaciones de Investigadores", "Sistema de aplicación y revisión de investigadores externos"],
  ["grants", "Seguimiento de Subsidios", "Seguimiento y gestión de subsidios, financiadores y plazos de solicitudes"],
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

// --- Seed camera trap projects from existing deployment projectLabels ---
const ctProjectInsert = db.prepare(
  "INSERT OR IGNORE INTO ct_projects (name) VALUES (?)"
);

// 1. Create CT projects from distinct non-null projectLabel values
const distinctLabels = db
  .prepare("SELECT DISTINCT project_label FROM biochoco_deployments WHERE project_label IS NOT NULL")
  .all();
for (const row of distinctLabels) {
  ctProjectInsert.run(row.project_label);
}

// 2. Create a "General" catch-all project with Drive folder ID from env
const driveFolderId = process.env.CAMERA_TRAP_ROOT_FOLDER_ID || null;
const generalInsert = db.prepare(
  "INSERT OR IGNORE INTO ct_projects (name, drive_folder_id) VALUES (?, ?)"
);
generalInsert.run("General", driveFolderId);

// 3. Link deployments to their CT project by matching project_label → ct_projects.name
db.exec(`
  UPDATE biochoco_deployments
  SET ct_project_id = (SELECT id FROM ct_projects WHERE name = biochoco_deployments.project_label)
  WHERE project_label IS NOT NULL AND ct_project_id IS NULL
`);

// 4. Assign remaining deployments (null project_label) to "General"
db.exec(`
  UPDATE biochoco_deployments
  SET ct_project_id = (SELECT id FROM ct_projects WHERE name = 'General')
  WHERE ct_project_id IS NULL
`);

// 5. Bootstrap: give all current camera-trap and grabaciones users access to
// all CT projects. CT sub-projects gate deployments, which are shared between
// the camera-trap and audio (grabaciones) modules — so audio users also need
// rows here or their audio queries return nothing.
const deploymentUsers = db
  .prepare(
    "SELECT DISTINCT user_email FROM user_permissions WHERE project_id IN ('camera-trap', 'grabaciones')"
  )
  .all();
const allCtProjects = db.prepare("SELECT id FROM ct_projects").all();
const insertAccess = db.prepare(
  "INSERT OR IGNORE INTO ct_project_access (user_email, ct_project_id) VALUES (?, ?)"
);
for (const user of deploymentUsers) {
  for (const proj of allCtProjects) {
    insertAccess.run(user.user_email, proj.id);
  }
}

const totalCtProjects = db.prepare("SELECT COUNT(*) as count FROM ct_projects").get();
const totalAccess = db.prepare("SELECT COUNT(*) as count FROM ct_project_access").get();
console.log(`CT Projects: ${totalCtProjects.count} total, ${totalAccess.count} access grants`);

db.close();
