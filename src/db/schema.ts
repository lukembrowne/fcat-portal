/**
 * Database Schema for FCAT Portal
 *
 * Tables:
 * - users, projects, user_permissions (auth/permissions)
 * - biochoco_deployments, biochoco_processing_jobs, biochoco_images, biochoco_detections, biochoco_identifications, biochoco_species (camera trap)
 * - ibutton_uploads, ibutton_readings (iButton temperature data)
 * - audio_files (passive audio recorder recordings)
 * - finance_transactions, finance_budget_items, finance_category_map,
 *   finance_sueldos_grants, finance_sueldos_totals, finance_projections,
 *   finance_uploads (financial dashboard)
 */

import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users = sqliteTable("users", {
  email: text("email").primaryKey(),
  name: text("name"),
  isExternal: integer("is_external", { mode: "boolean" })
    .notNull()
    .default(false),
  globalRole: text("global_role", { enum: ["super_admin"] }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// User Permissions
// ---------------------------------------------------------------------------

export const userPermissions = sqliteTable(
  "user_permissions",
  {
    userEmail: text("user_email")
      .notNull()
      .references(() => users.email, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor", "admin"] }).notNull(),
    grantedAt: integer("granted_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    primaryKey({ columns: [table.userEmail, table.projectId] }),
    index("idx_user_permissions_user_email").on(table.userEmail),
    index("idx_user_permissions_project_id").on(table.projectId),
  ]
);

// ---------------------------------------------------------------------------
// App State (generic key/value for cross-module timestamps and flags)
// ---------------------------------------------------------------------------

export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// Camera Trap Projects (sub-projects within camera-trap module)
// ---------------------------------------------------------------------------

export const cameraTrapProjects = sqliteTable("ct_projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  driveFolderId: text("drive_folder_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// Camera Trap Project Access (user ↔ CT project assignments)
// ---------------------------------------------------------------------------

export const cameraTrapProjectAccess = sqliteTable(
  "ct_project_access",
  {
    userEmail: text("user_email")
      .notNull()
      .references(() => users.email, { onDelete: "cascade" }),
    cameraTrapProjectId: integer("ct_project_id")
      .notNull()
      .references(() => cameraTrapProjects.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.userEmail, table.cameraTrapProjectId] }),
  ]
);

// ---------------------------------------------------------------------------
// Deployments (camera trap installations)
// ---------------------------------------------------------------------------

export const deployments = sqliteTable(
  "biochoco_deployments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path"),
    name: text("name").notNull(),
    driveFolderId: text("drive_folder_id"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    dateStart: text("date_start"),
    dateEnd: text("date_end"),
    totalImages: integer("total_images").default(0),
    totalVideos: integer("total_videos").default(0),
    status: text("status", {
      enum: ["unscanned", "scanned", "processing", "processed", "verified", "verified_empty"],
    })
      .notNull()
      .default("unscanned"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    createdBy: text("created_by"),
    cameraTrapProjectId: integer("ct_project_id").references(
      () => cameraTrapProjects.id,
      { onDelete: "set null" }
    ),
    projectLabel: text("project_label"),
    siteName: text("site_name"),
    odkSubmissionId: text("odk_submission_id"),
    metadataSource: text("metadata_source", {
      enum: ["manual", "odk", "drive"],
    }),
    // QA metadata
    excluded: integer("excluded", { mode: "boolean" }).notNull().default(false),
    validStart: text("valid_start"),
    validEnd: text("valid_end"),
    qaNotes: text("qa_notes"),
    // Field notes (operational context — equipment issues, missing data explanations)
    fieldNotes: text("field_notes"),
    // Upload cache (Drive file counts)
    uploadCameraCount: integer("upload_camera_count"),
    uploadAudioCount: integer("upload_audio_count"),
    uploadIbuttonCount: integer("upload_ibutton_count"),
    // Audio-calibration folder (manual drop folder; counted on the datos page,
    // not routed via the field uploader, not fed into BirdNET).
    uploadCalibrationCount: integer("upload_calibration_count"),
    uploadCameraFolderId: text("upload_camera_folder_id"),
    uploadAudioFolderId: text("upload_audio_folder_id"),
    uploadIbuttonFolderId: text("upload_ibutton_folder_id"),
    uploadCalibrationFolderId: text("upload_calibration_folder_id"),
    uploadCountsCheckedAt: integer("upload_counts_checked_at", { mode: "timestamp" }),
    // Upload cache — file sizes (bytes) and newest file dates
    uploadCameraSizeBytes: integer("upload_camera_size_bytes"),
    uploadAudioSizeBytes: integer("upload_audio_size_bytes"),
    uploadIbuttonSizeBytes: integer("upload_ibutton_size_bytes"),
    uploadCalibrationSizeBytes: integer("upload_calibration_size_bytes"),
    uploadNewestCameraDate: text("upload_newest_camera_date"),
    uploadNewestAudioDate: text("upload_newest_audio_date"),
    uploadNewestIbuttonDate: text("upload_newest_ibutton_date"),
    uploadNewestCalibrationDate: text("upload_newest_calibration_date"),
    // Previous-run upload counts (for per-deployment deltas in nightly email)
    previousCameraCount: integer("previous_camera_count"),
    previousAudioCount: integer("previous_audio_count"),
    previousIbuttonCount: integer("previous_ibutton_count"),
    previousCountsCheckedAt: integer("previous_counts_checked_at", { mode: "timestamp" }),
    // Training split assignment for custom classifier (write-once, set by exporter)
    trainingSplit: text("training_split", { enum: ["train", "val", "test"] }),
    // External (non-FCAT) provenance: true for synthetic deployments holding
    // imported LILA images. One per source dataset, pinned to the train split,
    // and skipped by split-hash + stratification (see the exporter).
    isExternal: integer("is_external", { mode: "boolean" })
      .notNull()
      .default(false),
    // Which Shared Drive hosts this deployment's data (multi-drive fan-out).
    // Nullable: legacy rows + rows with NULL driveFolderId stay NULL. Routing
    // sets it on rows it creates. ON DELETE RESTRICT in push-schema.mjs.
    sharedDriveId: text("shared_drive_id").references(() => sharedDrives.id),
  },
  (table) => [
    uniqueIndex("idx_biochoco_deployments_project_path").on(
      table.projectId,
      table.path
    ),
    uniqueIndex("idx_biochoco_deployments_project_drive_folder").on(
      table.projectId,
      table.driveFolderId
    ),
    index("idx_biochoco_deployments_shared_drive_id").on(table.sharedDriveId),
  ]
);

// ---------------------------------------------------------------------------
// Processing Jobs
// ---------------------------------------------------------------------------

export const processingJobs = sqliteTable("biochoco_processing_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deploymentId: integer("deployment_id").references(() => deployments.id, {
    onDelete: "cascade",
  }),
  cameraTrapProjectId: integer("camera_trap_project_id").references(
    () => cameraTrapProjects.id,
    { onDelete: "set null" }
  ),
  detectorModel: text("detector_model"),
  classifierModel: text("classifier_model"),
  confidenceThreshold: real("confidence_threshold").default(0.1),
  status: text("status", {
    enum: ["pending", "processing", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("pending"),
  jobType: text("job_type").notNull().default("ml"),
  pid: integer("pid"),
  totalImages: integer("total_images").notNull().default(0),
  processedImages: integer("processed_images").notNull().default(0),
  failedImages: integer("failed_images").notNull().default(0),
  statusMessage: text("status_message"),
  errorMessage: text("error_message"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  createdBy: text("created_by"),
  frameExtractionRate: real("frame_extraction_rate").default(1.0),
  totalVideos: integer("total_videos").default(0),
  extractedFrames: integer("extracted_frames").default(0),
  compressFirst: integer("compress_first", { mode: "boolean" }).default(false),
  videoTimestampMethod: text("video_timestamp_method", {
    enum: ["metadata", "filename_folder", "none"],
  }).default("metadata"),
  downloadedImages: integer("downloaded_images").default(0),
  downloadTotal: integer("download_total").default(0),
  cachedImages: integer("cached_images").default(0),
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const images = sqliteTable(
  "biochoco_images",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deploymentId: integer("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    jobId: integer("job_id").references(() => processingJobs.id, {
      onDelete: "set null",
    }),
    filename: text("filename").notNull(),
    path: text("path"),
    driveFileId: text("drive_file_id"),
    fileSize: integer("file_size"),
    fileModified: integer("file_modified", { mode: "timestamp" }),
    exifTimestamp: text("exif_timestamp"),
    status: text("status", {
      enum: ["pending", "processed", "failed"],
    })
      .notNull()
      .default("pending"),
    errorMessage: text("error_message"),
    thumbnailPath: text("thumbnail_path"),
    videoId: integer("video_id").references(() => videos.id, {
      onDelete: "cascade",
    }),
    frameIndex: integer("frame_index"),
    confirmedBlank: integer("confirmed_blank", { mode: "boolean" })
      .notNull()
      .default(false),
    compressed: integer("compressed", { mode: "boolean" })
      .notNull()
      .default(false),
    originalFileSize: integer("original_file_size"),
    starred: integer("starred", { mode: "boolean" })
      .notNull()
      .default(false),
    starredBy: text("starred_by"),
    starredAt: integer("starred_at", { mode: "timestamp" }),
    setupTag: text("setup_tag"),  // 'deployment' | 'retrieval' | null
    // Mirror of the deployment's external flag, for fast filtering of crops.
    isExternal: integer("is_external", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    index("idx_biochoco_images_deployment_id").on(table.deploymentId),
    index("idx_biochoco_images_job_id").on(table.jobId),
    uniqueIndex("idx_biochoco_images_deployment_drive_file").on(
      table.deploymentId,
      table.driveFileId
    ),
  ]
);

// ---------------------------------------------------------------------------
// Videos (camera trap video files)
// ---------------------------------------------------------------------------

export const videos = sqliteTable(
  "biochoco_videos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deploymentId: integer("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    driveFileId: text("drive_file_id"),
    fileSize: integer("file_size"),
    fileModified: integer("file_modified", { mode: "timestamp" }),
    path: text("path"),
    duration: real("duration"),
    status: text("status", {
      enum: ["pending", "processed", "failed"],
    })
      .notNull()
      .default("pending"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("idx_biochoco_videos_deployment_id").on(table.deploymentId),
    uniqueIndex("idx_biochoco_videos_deployment_drive_file").on(
      table.deploymentId,
      table.driveFileId
    ),
  ]
);

// ---------------------------------------------------------------------------
// Detections (bounding boxes from MegaDetector)
// ---------------------------------------------------------------------------

export const detections = sqliteTable(
  "biochoco_detections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    imageId: integer("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    jobId: integer("job_id")
      .references(() => processingJobs.id, { onDelete: "set null" }),
    bboxX: real("bbox_x").notNull(),
    bboxY: real("bbox_y").notNull(),
    bboxWidth: real("bbox_width").notNull(),
    bboxHeight: real("bbox_height").notNull(),
    detectionConfidence: real("detection_confidence").notNull(),
    detectionClass: integer("detection_class").notNull().default(0),
    modelVersion: text("model_version"),
  },
  (table) => [
    index("idx_biochoco_detections_image_id").on(table.imageId),
    index("idx_biochoco_detections_job_id").on(table.jobId),
  ]
);

// ---------------------------------------------------------------------------
// Identifications (species classification per detection)
// ---------------------------------------------------------------------------

export const identifications = sqliteTable(
  "biochoco_identifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    detectionId: integer("detection_id")
      .notNull()
      .references(() => detections.id, { onDelete: "cascade" }),
    species: text("species").notNull(),
    confidence: real("confidence").notNull(),
    modelVersion: text("model_version"),
    verificationStatus: text("verification_status", {
      enum: ["unverified", "verified", "rejected", "corrected"],
    })
      .notNull()
      .default("unverified"),
    correctedSpecies: text("corrected_species"),
    verifiedBy: text("verified_by"),
    verifiedAt: integer("verified_at", { mode: "timestamp" }),
    // Custom classifier provenance — null for legacy AI4G identifications
    classifierModelId: integer("classifier_model_id").references(
      () => cameraTrapModels.id,
      { onDelete: "set null" }
    ),
  },
  (table) => [
    index("idx_biochoco_identifications_detection_id").on(table.detectionId),
  ]
);

// ---------------------------------------------------------------------------
// External Images (provenance for imported non-FCAT training data, e.g. LILA)
// ---------------------------------------------------------------------------

export const externalImages = sqliteTable(
  "biochoco_external_images",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    imageId: integer("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    // Source dataset slug, e.g. "orinoquia" | "wcs".
    sourceDataset: text("source_dataset").notNull(),
    // Original image id within the source dataset; idempotency key with dataset.
    sourceImageId: text("source_image_id").notNull(),
    sourceUrl: text("source_url"),
    // Taxon as labeled by the source, before mapping to our canonical class.
    originalTaxon: text("original_taxon"),
    license: text("license"),
    // Canonical class this image was mapped into (FK to species when resolvable).
    mappedSpeciesId: integer("mapped_species_id").references(
      () => species.id,
      { onDelete: "set null" }
    ),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("idx_biochoco_external_images_image_id").on(table.imageId),
    uniqueIndex("idx_biochoco_external_images_source").on(
      table.sourceDataset,
      table.sourceImageId
    ),
    index("idx_biochoco_external_images_dataset").on(table.sourceDataset),
  ]
);

// ---------------------------------------------------------------------------
// Camera Trap — Training Datasets (versioned exports for custom classifier)
// ---------------------------------------------------------------------------

export const cameraTrapTrainingDatasets = sqliteTable(
  "camera_trap_training_datasets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    version: text("version").notNull().unique(),
    contentHash: text("content_hash").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    createdBy: text("created_by").notNull(),
    imageCount: integer("image_count").notNull(),
    // Per-source split of imageCount (nullable for pre-LILA exports).
    fcatImageCount: integer("fcat_image_count"),
    externalImageCount: integer("external_image_count"),
    classCount: integer("class_count").notNull(),
    minExamplesThreshold: integer("min_examples_threshold").notNull(),
    classListJson: text("class_list_json").notNull(),
    droppedSpeciesJson: text("dropped_species_json").notNull(),
    deploymentsJson: text("deployments_json").notNull(),
    manifestPath: text("manifest_path").notNull(),
    // Crop-quality knobs used for this export (nullable for pre-2026-05 rows).
    detectionConfidenceFloor: real("detection_confidence_floor"),
    cropPadding: real("crop_padding"),
    cropLongEdge: integer("crop_long_edge"),
    jpegQuality: integer("jpeg_quality"),
    // Drive archive (set once the export is packaged + uploaded for sharing).
    driveArchiveFileId: text("drive_archive_file_id"),
    driveArchiveWebViewLink: text("drive_archive_web_view_link"),
    archiveUploadedAt: integer("archive_uploaded_at", { mode: "timestamp" }),
  }
);

// ---------------------------------------------------------------------------
// Camera Trap — Models (registered custom classifier weights)
// ---------------------------------------------------------------------------

export const cameraTrapModels = sqliteTable(
  "camera_trap_models",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    version: text("version").notNull().unique(),
    modelDir: text("model_dir").notNull(),
    classMappingJson: text("class_mapping_json").notNull(),
    metricsJson: text("metrics_json").notNull(),
    // { classes: string[], matrix: number[][], axisConvention: "row=true,col=pred" }
    // Nullable for legacy v1 models (registered before contract v2).
    confusionMatrixJson: text("confusion_matrix_json"),
    confidenceThreshold: real("confidence_threshold").notNull(),
    trainingDatasetId: integer("training_dataset_id").references(
      () => cameraTrapTrainingDatasets.id,
      { onDelete: "set null" }
    ),
    active: integer("active", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    uniqueIndex("idx_camera_trap_models_active")
      .on(table.active)
      .where(sql`active = 1`),
  ]
);

// ---------------------------------------------------------------------------
// Camera Trap — Per-class metrics (one row per model × class)
// ---------------------------------------------------------------------------
// CASCADE on model delete: rows are derived data, meaningless without parent.
// (Contrast biochoco_identifications.classifier_model_id → SET NULL, which
// preserves audit evidence of work done.)

export const cameraTrapModelClassMetrics = sqliteTable(
  "camera_trap_model_class_metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    modelId: integer("model_id")
      .notNull()
      .references(() => cameraTrapModels.id, { onDelete: "cascade" }),
    className: text("class_name").notNull(),
    // Nullable: sklearn produces NaN when support=0; we store NULL.
    precisionValue: real("precision_value"),
    recall: real("recall"),
    f1: real("f1"),
    support: integer("support").notNull(),
    // Nullable: decouples contract enforcement (in importer) from storage,
    // so a future backfill of v1 models doesn't need a schema change.
    trainCount: integer("train_count"),
  },
  (table) => [
    // Composite unique is the only index needed — SQLite uses it as a
    // prefix index for `WHERE model_id = ?`. No current query filters by
    // class_name alone.
    uniqueIndex("idx_ct_mcm_model_class").on(table.modelId, table.className),
  ]
);

// ---------------------------------------------------------------------------
// Species Lookup Table
// ---------------------------------------------------------------------------

export const species = sqliteTable("biochoco_species", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scientificName: text("scientific_name").notNull().unique(),
  commonName: text("common_name").notNull(),
  spanishName: text("spanish_name"),
  taxonomicRank: text("taxonomic_rank", {
    enum: ["class", "order", "family", "genus", "species"],
  })
    .notNull()
    .default("species"),
  type: text("type", {
    enum: ["mammal", "bird", "reptile", "amphibian", "insect", "system"],
  })
    .notNull()
    .default("mammal"),
});

// ---------------------------------------------------------------------------
// Activity Log (audit trail for BioChoco tools, etc.)
// ---------------------------------------------------------------------------

export const activityLog = sqliteTable("activity_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userEmail: text("user_email").notNull(),
  action: text("action").notNull(),
  projectId: text("project_id"),
  targetType: text("target_type"),
  targetId: text("target_id"),
  details: text("details"), // JSON
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// System Events (unified activity log across cron, admin, ingestion, etc.)
// ---------------------------------------------------------------------------

export const EVENT_SOURCES = [
  "admin",
  "audio",
  "biochoco-overview",
  "biochoco-tools",
  "biochoco-resultados",
  "camera-trap",
  "climate",
  "cron",
  "finance",
  "grants",
  "odk",
  "shared-drives",
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_SEVERITIES = ["info", "success", "warn", "error"] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export const systemEvents = sqliteTable(
  "system_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    occurredAt: integer("occurred_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    eventType: text("event_type").notNull(),
    source: text("source", { enum: EVENT_SOURCES }).notNull(),
    severity: text("severity", { enum: EVENT_SEVERITIES })
      .notNull()
      .default("info"),
    actorEmail: text("actor_email"),
    projectId: text("project_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    summary: text("summary").notNull(),
    durationMs: integer("duration_ms"),
    details: text("details"),
  },
  (t) => [
    index("idx_system_events_occurred_at").on(t.occurredAt),
    index("idx_system_events_source").on(t.source),
    index("idx_system_events_event_type").on(t.eventType),
  ],
);

// ---------------------------------------------------------------------------
// Shared Drives (multi-drive capacity-based fan-out registry)
//
// Each row = one registered Google Shared Drive. Deployments fan out across
// these to stay under Google's 500,000-item-per-Shared-Drive hard cap. The
// codebase is already drive-agnostic (every Drive call uses supportsAllDrives),
// so this registry only drives the parent-folder selection on NEW deployments.
//
// Capacity model (two counters):
//   effectiveCount = reconciledCount + pendingReservationsCount
//   - reconciledCount: Drive API ground truth (nightly delta / weekly full)
//   - pendingReservationsCount: in-flight folder reservations (sum of open
//     reservation tokens; denormalized for cheap selector reads)
// ---------------------------------------------------------------------------

export const SHARED_DRIVE_STATUSES = [
  "registering",
  "active",
  "read-only",
  "unreachable",
] as const;
export type SharedDriveStatus = (typeof SHARED_DRIVE_STATUSES)[number];

export const sharedDrives = sqliteTable(
  "shared_drives",
  {
    // kebab-case slug, e.g. "fcat-biochoco", "fcat-biochoco-2"
    id: text("id").primaryKey(),
    // Google Shared Drive ID (validated /^0A[A-Za-z0-9_-]{15,40}$/). Used for
    // capacity ops: drives.get, files.list?driveId, changes.list?driveId.
    driveId: text("drive_id").notNull().unique(),
    // Folder under which NEW deployment folders are created, and the root that
    // discovery scans. For a fresh Shared Drive this equals driveId (the drive
    // root). For fcat-biochoco it is the legacy CAMERA_TRAP_ROOT_FOLDER_ID
    // subfolder where existing deployments already live.
    rootFolderId: text("root_folder_id").notNull(),
    // Display name confirmed via drives.get
    name: text("name").notNull(),
    // The camera-trap project this drive serves. One project per drive: a
    // project's drive pool = all rows with its id. Routing + discovery are
    // scoped to this so projects never cross-contaminate. Nullable only so the
    // migration is safe + unassigned drives are simply never selected.
    cameraTrapProjectId: integer("camera_trap_project_id").references(
      () => cameraTrapProjects.id,
    ),
    status: text("status", { enum: SHARED_DRIVE_STATUSES })
      .notNull()
      .default("registering"),
    // Drive API ground truth (last reconcile). Includes trashed items, because
    // Google's 500K cap counts them until purged (matches the Drive UI warning).
    reconciledCount: integer("reconciled_count").notNull().default(0),
    // Subset of reconciledCount currently in Trash (purgeable to reclaim
    // capacity). Refreshed on the weekly full count only. Advisory.
    trashedCount: integer("trashed_count").notNull().default(0),
    // In-flight reservations (sum of open reservation tokens; denormalized)
    pendingReservationsCount: integer("pending_reservations_count")
      .notNull()
      .default(0),
    itemCap: integer("item_cap").notNull().default(500000),
    // changes.list cursor; set after the initial full count
    changesPageToken: text("changes_page_token"),
    lastReconciledAt: text("last_reconciled_at"),
    lastFullReconcileAt: text("last_full_reconcile_at"),
    lastHealthCheckAt: text("last_health_check_at"),
    // Sanitized: ID-strings stripped, capped at 200 chars
    lastHealthStatus: text("last_health_status"),
    // Soft-archive flag (NULL = visible). Independent of status.
    archivedAt: text("archived_at"),
    notes: text("notes"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    // Selection hot path: pick a project's fullest active, non-archived drive.
    index("idx_shared_drives_project_status").on(
      t.cameraTrapProjectId,
      t.status,
      t.archivedAt,
    ),
  ],
);

export const sharedDriveReservations = sqliteTable(
  "shared_drive_reservations",
  {
    // UUID per reservation
    id: text("id").primaryKey(),
    sharedDriveId: text("shared_drive_id")
      .notNull()
      .references(() => sharedDrives.id),
    // DEPLOYMENT_QUOTA at reservation time
    quota: integer("quota").notNull(),
    // biochoco_deployments.id once known (nullable: set after folder insert)
    deploymentId: integer("deployment_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    // NULL until folded into reconciledCount or rolled back
    releasedAt: text("released_at"),
  },
  (t) => [
    index("idx_shared_drive_reservations_drive_open").on(
      t.sharedDriveId,
      t.releasedAt,
    ),
  ],
);

export type SharedDrive = typeof sharedDrives.$inferSelect;
export type NewSharedDrive = typeof sharedDrives.$inferInsert;
export type SharedDriveReservation = typeof sharedDriveReservations.$inferSelect;
export type NewSharedDriveReservation =
  typeof sharedDriveReservations.$inferInsert;

// ---------------------------------------------------------------------------
// Finance — Transactions (from LibroMayor CSV)
// ---------------------------------------------------------------------------

export const financeTransactions = sqliteTable(
  "finance_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fecha: text("fecha").notNull(),
    codigo: text("codigo").notNull(),
    cuentaNombre: text("cuenta_nombre").notNull(),
    asiento: text("asiento").notNull(),
    detalle: text("detalle"),
    actor: text("actor"),
    centrosDeIngreso: text("centros_de_ingreso"),
    cCosto: text("c_costo"),
    debe: real("debe").notNull().default(0),
    haber: real("haber").notNull().default(0),
    balance: real("balance"),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    yearMonth: text("year_month").notNull(),
    txType: text("tx_type", {
      enum: ["revenue", "expense", "cash", "other"],
    }).notNull(),
  },
  (table) => [
    index("idx_ft_fecha").on(table.fecha),
    index("idx_ft_codigo").on(table.codigo),
    index("idx_ft_tx_type").on(table.txType),
    index("idx_ft_year_month").on(table.yearMonth),
  ]
);

// ---------------------------------------------------------------------------
// Finance — Budget Items (from Annual Budget Excel)
// ---------------------------------------------------------------------------

export const financeBudgetItems = sqliteTable("finance_budget_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  budgetYear: integer("budget_year").notNull(),
  category: text("category").notNull(),
  amount: real("amount").notNull(),
});

// ---------------------------------------------------------------------------
// Finance — Category Map (Budget ↔ Accounting link)
// ---------------------------------------------------------------------------

export const financeCategoryMap = sqliteTable(
  "finance_category_map",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    budgetCategory: text("budget_category").notNull(),
    linkExpenseCategory: text("link_expense_category").notNull(),
  },
  (table) => [
    index("idx_fcm_budget_cat").on(table.budgetCategory),
    index("idx_fcm_link_cat").on(table.linkExpenseCategory),
  ]
);

// ---------------------------------------------------------------------------
// Finance — Sueldos Grants (from Sueldos Excel, Sheet 1)
// ---------------------------------------------------------------------------

export const financeSueldosGrants = sqliteTable("finance_sueldos_grants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  person: text("person").notNull(),
  source: text("source").notNull(),
  status: text("status", { enum: ["funded", "pending"] }).notNull(),
  amount: real("amount").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
});

// ---------------------------------------------------------------------------
// Finance — Sueldos Totals (from Sueldos Excel, Sheet 2)
// ---------------------------------------------------------------------------

export const financeSueldosTotals = sqliteTable("finance_sueldos_totals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  person: text("person").notNull().unique(),
  annualCost: real("annual_cost").notNull(),
  monthlyCost: real("monthly_cost").notNull(),
});

// ---------------------------------------------------------------------------
// Finance — Projections (user-editable cashflow projections)
// ---------------------------------------------------------------------------

export const financeProjections = sqliteTable("finance_projections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type", { enum: ["income", "expense"] }).notNull(),
  status: text("status", {
    enum: ["confirmed", "very_likely", "maybe"],
  })
    .notNull()
    .default("confirmed"),
  amount: real("amount").notNull(),
  date: text("date").notNull(),
  includeInProjection: integer("include_in_projection", { mode: "boolean" })
    .notNull()
    .default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// Finance — Uploads (metadata for tracking data imports)
// ---------------------------------------------------------------------------

export const financeUploads = sqliteTable("finance_uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fileType: text("file_type", {
    enum: ["libro_mayor", "budget", "category_map", "sueldos"],
  }).notNull(),
  fileName: text("file_name").notNull(),
  rowCount: integer("row_count"),
  uploadedBy: text("uploaded_by").notNull(),
  uploadedAt: integer("uploaded_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// Climate — Readings (hourly + 15-min weather station data)
// ---------------------------------------------------------------------------

export const climateReadings = sqliteTable(
  "climate_readings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    timestamp: text("timestamp").notNull(),
    resolution: text("resolution", { enum: ["hourly", "15min"] }).notNull(),
    recordNum: integer("record_num"),
    airTempAvg: real("air_temp_avg"),
    airTempMax: real("air_temp_max"),
    airTempMin: real("air_temp_min"),
    humidityAvg: real("humidity_avg"),
    humidityMax: real("humidity_max"),
    humidityMin: real("humidity_min"),
    pressureAvg: real("pressure_avg"),
    pressureMax: real("pressure_max"),
    pressureMin: real("pressure_min"),
    rainMm: real("rain_mm"),
    solarAvg: real("solar_avg"),
    solarMax: real("solar_max"),
    solarMin: real("solar_min"),
    windDirAvg: real("wind_dir_avg"),
    windDirMax: real("wind_dir_max"),
    windDirMin: real("wind_dir_min"),
    windSpeedAvg: real("wind_speed_avg"),
    windSpeedMax: real("wind_speed_max"),
    windSpeedMin: real("wind_speed_min"),
    meanWindSpeed: real("mean_wind_speed"),
    meanWindDirection: real("mean_wind_direction"),
    stdWindDir: real("std_wind_dir"),
    // Per-cell QC provenance. Sparse JSON map of field → { flag, raw }, e.g.
    // {"air_temp_avg":{"flag":"R","raw":-8.82}}. Flag codes: R = removed
    // (out of plausible range), Q = removed by manual review. The working
    // numeric columns above are set to NULL when a cell is flagged; this
    // column preserves the original value and the reason it was removed.
    qcFlags: text("qc_flags"),
  },
  (table) => [
    uniqueIndex("idx_climate_readings_ts_res").on(
      table.timestamp,
      table.resolution
    ),
    index("idx_climate_readings_res_ts").on(table.resolution, table.timestamp),
  ]
);

// ---------------------------------------------------------------------------
// Climate — Uploads (tracking data imports)
// ---------------------------------------------------------------------------

export const climateUploads = sqliteTable("climate_uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filename: text("filename").notNull(),
  resolution: text("resolution", { enum: ["hourly", "15min"] }).notNull(),
  rowsImported: integer("rows_imported").notNull(),
  dateRangeStart: text("date_range_start"),
  dateRangeEnd: text("date_range_end"),
  uploadedBy: text("uploaded_by").notNull(),
  uploadedAt: integer("uploaded_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// Climate — Edits (audit trail for manual data corrections)
// ---------------------------------------------------------------------------

export const climateEdits = sqliteTable("climate_edits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: text("timestamp").notNull(),
  resolution: text("resolution", { enum: ["hourly", "15min"] }).notNull(),
  columnName: text("column_name").notNull(),
  oldValue: real("old_value"),
  editedBy: text("edited_by").notNull(),
  editedAt: integer("edited_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  reason: text("reason"),
});

// ---------------------------------------------------------------------------
// iButton — Uploads (tracking processed iButton files per deployment)
// ---------------------------------------------------------------------------

export const ibuttonUploads = sqliteTable("ibutton_uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deploymentId: integer("deployment_id")
    .notNull()
    .unique()
    .references(() => deployments.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  deviceSerial: text("device_serial"),
  sampleRate: text("sample_rate"),
  missionStart: text("mission_start"),
  rowsImported: integer("rows_imported").notNull(),
  dateRangeStart: text("date_range_start"),
  dateRangeEnd: text("date_range_end"),
  processedBy: text("processed_by").notNull(),
  processedAt: integer("processed_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// iButton — Readings (individual temperature measurements)
// ---------------------------------------------------------------------------

export const ibuttonReadings = sqliteTable(
  "ibutton_readings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deploymentId: integer("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    uploadId: integer("upload_id")
      .notNull()
      .references(() => ibuttonUploads.id, { onDelete: "cascade" }),
    timestamp: text("timestamp").notNull(),
    temperatureC: real("temperature_c").notNull(),
    flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("idx_ibutton_readings_dep_ts").on(
      table.deploymentId,
      table.timestamp
    ),
    index("idx_ibutton_readings_dep").on(table.deploymentId),
  ]
);

// ---------------------------------------------------------------------------
// Audio Files (passive audio recorder recordings)
// ---------------------------------------------------------------------------

export const audioFiles = sqliteTable(
  "audio_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deploymentId: integer("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    driveFileId: text("drive_file_id"),
    fileSize: integer("file_size"),
    mimeType: text("mime_type"),
    modifiedAt: integer("modified_at", { mode: "timestamp" }),
    format: text("format"),
    playable: integer("playable", { mode: "boolean" }).notNull().default(true),
    duration: real("duration"),
    sampleRate: integer("sample_rate"),
    cachePath: text("cache_path"),
    spectrogramPath: text("spectrogram_path"),
    // FLAC compression tracking — set by the audio_compression job.
    // `compressed=true` is also set for non_compressible WAVs (kept as-is, no Drive write).
    // Only rows where `originalDriveRevisionId IS NOT NULL` are revertible.
    compressed: integer("compressed", { mode: "boolean" }).notNull().default(false),
    originalFileSize: integer("original_file_size"),
    originalDriveRevisionId: text("original_drive_revision_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_audio_files_deployment_id").on(table.deploymentId),
    uniqueIndex("idx_audio_files_deployment_drive_file").on(
      table.deploymentId,
      table.driveFileId
    ),
  ]
);

// ---------------------------------------------------------------------------
// Audio Detections (time-frequency bounding boxes on spectrograms)
// ---------------------------------------------------------------------------

export const audioDetections = sqliteTable(
  "audio_detections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    audioFileId: integer("audio_file_id")
      .notNull()
      .references(() => audioFiles.id, { onDelete: "cascade" }),
    startTime: real("start_time").notNull(),
    endTime: real("end_time").notNull(),
    minFreq: real("min_freq").notNull(),
    maxFreq: real("max_freq").notNull(),
    confidence: real("confidence"),
    modelVersion: text("model_version"),
    jobId: integer("job_id").references(() => processingJobs.id, { onDelete: "set null" }),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_audio_detections_file").on(table.audioFileId),
    index("idx_audio_detections_job").on(table.jobId),
  ]
);

// ---------------------------------------------------------------------------
// Audio Identifications (species labels for audio detections)
// ---------------------------------------------------------------------------

export const audioIdentifications = sqliteTable(
  "audio_identifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    audioDetectionId: integer("audio_detection_id")
      .notNull()
      .references(() => audioDetections.id, { onDelete: "cascade" }),
    species: text("species").notNull(),
    confidence: real("confidence"),
    modelVersion: text("model_version"),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    correctedSpecies: text("corrected_species"),
    verifiedBy: text("verified_by"),
    verifiedAt: integer("verified_at", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_audio_identifications_detection").on(table.audioDetectionId),
  ]
);

// ---------------------------------------------------------------------------
// Acoustic Indices (Müller 2023 / Kümmet 2025 five-index recipe per audio file)
// ---------------------------------------------------------------------------
//
// 1:1 with audio_files. On re-run with new config, the latest row wins via
// ON CONFLICT DO UPDATE on the unique audio_file_id index. We accept that
// time-series comparison of older config values is not supported; if the
// algorithm changes, delete + recompute.

export const acousticIndices = sqliteTable(
  "acoustic_indices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    audioFileId: integer("audio_file_id")
      .notNull()
      .references(() => audioFiles.id, { onDelete: "cascade" }),
    soundscapeSaturation: real("soundscape_saturation"),
    acousticComplexityIndex: real("acoustic_complexity_index"),
    frequencyEntropy: real("frequency_entropy"),
    temporalEntropy: real("temporal_entropy"),
    eventsPerSecond: real("events_per_second"),
    recordedDate: text("recorded_date"),
    dielPeriod: text("diel_period").notNull(),
    configHash: text("config_hash").notNull(),
    computedAt: integer("computed_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_ai_audio_file").on(table.audioFileId),
  ]
);

// ---------------------------------------------------------------------------
// Share Tokens (public share links for camera trap deployments)
// ---------------------------------------------------------------------------

export const shareTokens = sqliteTable(
  "share_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    token: text("token").notNull().unique(),
    deploymentId: integer("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull(),
    label: text("label"),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_share_tokens_token").on(table.token),
    index("idx_share_tokens_deployment").on(table.deploymentId),
  ]
);

// ---------------------------------------------------------------------------
// Site Share Tokens (public share links for biochoco site results pages)
// ---------------------------------------------------------------------------
//
// Scope: an entire biochoco site (e.g. "NAC-005"), aggregating every camera
// trap deployment, habitat assessment, and iButton record at that site.
//
// `deploymentIds` is materialized at creation time as a JSON array of
// deployment row IDs. The biochoco "site" is an ODK entity (no DB FK),
// and the deployment→site mapping has a name-pattern fallback that pure
// SQL can't reproduce, so we snapshot the resolved list at create time.
//
// `heroImageId` is chosen at creation time for OG link previews.
// `idx_site_share_tokens_site_active` is a UNIQUE partial index — only one
// active (non-revoked) token may exist per site. The create action revokes
// any existing active token in the same transaction before inserting.

export const siteShareTokens = sqliteTable(
  "site_share_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    token: text("token").notNull().unique(),
    biochocoSiteId: text("biochoco_site_id").notNull(),
    deploymentIds: text("deployment_ids").notNull(),
    heroImageId: integer("hero_image_id"),
    createdBy: text("created_by").notNull(),
    label: text("label"),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_site_share_tokens_token").on(table.token),
    uniqueIndex("idx_site_share_tokens_site_active")
      .on(table.biochocoSiteId)
      .where(sql`${table.revokedAt} IS NULL`),
  ]
);

// ---------------------------------------------------------------------------
// Upload Count Snapshots (daily aggregate of Drive upload counts)
// ---------------------------------------------------------------------------

export const uploadCountSnapshots = sqliteTable("upload_count_snapshots", {
  date: text("date").primaryKey(),
  totalCameras: integer("total_cameras").notNull().default(0),
  totalAudio: integer("total_audio").notNull().default(0),
  totalIbutton: integer("total_ibutton").notNull().default(0),
  totalCameraSizeBytes: integer("total_camera_size_bytes").notNull().default(0),
  totalAudioSizeBytes: integer("total_audio_size_bytes").notNull().default(0),
  totalIbuttonSizeBytes: integer("total_ibutton_size_bytes").notNull().default(0),
  deploymentsWithUploads: integer("deployments_with_uploads").notNull().default(0),
  totalDeployments: integer("total_deployments").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// Type Exports
// ---------------------------------------------------------------------------

export type CameraTrapProject = typeof cameraTrapProjects.$inferSelect;
export type NewCameraTrapProject = typeof cameraTrapProjects.$inferInsert;

export type CameraTrapProjectAccessRow = typeof cameraTrapProjectAccess.$inferSelect;
export type NewCameraTrapProjectAccess = typeof cameraTrapProjectAccess.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type UserPermissionRow = typeof userPermissions.$inferSelect;
export type NewUserPermission = typeof userPermissions.$inferInsert;

export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;

export type ProcessingJob = typeof processingJobs.$inferSelect;
export type NewProcessingJob = typeof processingJobs.$inferInsert;

export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;

export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;

export type Detection = typeof detections.$inferSelect;
export type NewDetection = typeof detections.$inferInsert;

export type Identification = typeof identifications.$inferSelect;
export type NewIdentification = typeof identifications.$inferInsert;

export type ExternalImage = typeof externalImages.$inferSelect;
export type NewExternalImage = typeof externalImages.$inferInsert;

export type CameraTrapTrainingDataset =
  typeof cameraTrapTrainingDatasets.$inferSelect;
export type NewCameraTrapTrainingDataset =
  typeof cameraTrapTrainingDatasets.$inferInsert;

export type CameraTrapModel = typeof cameraTrapModels.$inferSelect;
export type NewCameraTrapModel = typeof cameraTrapModels.$inferInsert;

export type CameraTrapModelClassMetric =
  typeof cameraTrapModelClassMetrics.$inferSelect;
export type NewCameraTrapModelClassMetric =
  typeof cameraTrapModelClassMetrics.$inferInsert;

export type Species = typeof species.$inferSelect;
export type NewSpecies = typeof species.$inferInsert;

export type ActivityLog = typeof activityLog.$inferSelect;
export type NewActivityLog = typeof activityLog.$inferInsert;

export type IbuttonUpload = typeof ibuttonUploads.$inferSelect;
export type NewIbuttonUpload = typeof ibuttonUploads.$inferInsert;

export type IbuttonReading = typeof ibuttonReadings.$inferSelect;
export type NewIbuttonReading = typeof ibuttonReadings.$inferInsert;

export type FinanceTransaction = typeof financeTransactions.$inferSelect;
export type NewFinanceTransaction = typeof financeTransactions.$inferInsert;

export type FinanceBudgetItem = typeof financeBudgetItems.$inferSelect;
export type NewFinanceBudgetItem = typeof financeBudgetItems.$inferInsert;

export type FinanceCategoryMapRow = typeof financeCategoryMap.$inferSelect;
export type NewFinanceCategoryMapRow = typeof financeCategoryMap.$inferInsert;

export type FinanceSueldosGrant = typeof financeSueldosGrants.$inferSelect;
export type NewFinanceSueldosGrant = typeof financeSueldosGrants.$inferInsert;

export type FinanceSueldosTotal = typeof financeSueldosTotals.$inferSelect;
export type NewFinanceSueldosTotal = typeof financeSueldosTotals.$inferInsert;

export type FinanceProjection = typeof financeProjections.$inferSelect;
export type NewFinanceProjection = typeof financeProjections.$inferInsert;

export type FinanceUpload = typeof financeUploads.$inferSelect;
export type NewFinanceUpload = typeof financeUploads.$inferInsert;

export type AcousticIndicesRow = typeof acousticIndices.$inferSelect;
export type NewAcousticIndicesRow = typeof acousticIndices.$inferInsert;

export type ClimateReading = typeof climateReadings.$inferSelect;
export type NewClimateReading = typeof climateReadings.$inferInsert;

export type ClimateUpload = typeof climateUploads.$inferSelect;
export type NewClimateUpload = typeof climateUploads.$inferInsert;

export type ClimateEdit = typeof climateEdits.$inferSelect;
export type NewClimateEdit = typeof climateEdits.$inferInsert;

export type ClimateResolution = "hourly" | "15min";

export type AudioFile = typeof audioFiles.$inferSelect;
export type NewAudioFile = typeof audioFiles.$inferInsert;

export type AudioDetection = typeof audioDetections.$inferSelect;
export type NewAudioDetection = typeof audioDetections.$inferInsert;

export type AudioIdentification = typeof audioIdentifications.$inferSelect;
export type NewAudioIdentification = typeof audioIdentifications.$inferInsert;

export type UploadCountSnapshot = typeof uploadCountSnapshots.$inferSelect;
export type NewUploadCountSnapshot = typeof uploadCountSnapshots.$inferInsert;

export type ShareToken = typeof shareTokens.$inferSelect;
export type NewShareToken = typeof shareTokens.$inferInsert;

export type SiteShareToken = typeof siteShareTokens.$inferSelect;
export type NewSiteShareToken = typeof siteShareTokens.$inferInsert;

// ---------------------------------------------------------------------------
// Researcher Applications
// ---------------------------------------------------------------------------

export const researchApplicationStatusEnum = [
  "submitted",
  "under_review",
  "accepted",
  "rejected",
  "revisions_requested",
] as const;
export type ResearchApplicationStatus =
  (typeof researchApplicationStatusEnum)[number];

export const researchApplications = sqliteTable(
  "research_applications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    externalId: text("external_id"),
    referenceCode: text("reference_code"),
    status: text("status", { enum: researchApplicationStatusEnum })
      .notNull()
      .default("submitted"),
    projectTitle: text("project_title").notNull(),
    piFullName: text("pi_full_name").notNull(),
    piEmail: text("pi_email").notNull(),
    piPhone: text("pi_phone"),
    piInstitution: text("pi_institution"),
    collaborators: text("collaborators"),
    projectStartDate: text("project_start_date"),
    projectEndDate: text("project_end_date"),
    projectGoals: text("project_goals"),
    methods: text("methods"),
    samplesDetails: text("samples_details"),
    geneticResources: text("genetic_resources"),
    needsFcatAssistance: integer("needs_fcat_assistance", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    facilitiesNeeds: text("facilities_needs"),
    permanentEquipment: text("permanent_equipment"),
    personnelCollaboration: text("personnel_collaboration"),
    communityEngagement: text("community_engagement"),
    dataSharing: text("data_sharing"),
    codeOfConductAgreed: integer("code_of_conduct_agreed", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    guidelinesAgreed: integer("guidelines_agreed", { mode: "boolean" })
      .notNull()
      .default(false),
    permitsStatus: text("permits_status"),
    driveFolderId: text("drive_folder_id"),
    driveFilesJson: text("drive_files_json"),
    primaryReviewerEmail: text("primary_reviewer_email"),
    decisionNotes: text("decision_notes"),
    finalReportDueDate: text("final_report_due_date"),
    reportSubmitToken: text("report_submit_token"),
    reportSubmitTokenExpiresAt: text("report_submit_token_expires_at"),
    reminder30SentAt: integer("reminder_30_sent_at", { mode: "timestamp" }),
    reminder0SentAt: integer("reminder_0_sent_at", { mode: "timestamp" }),
    reminderOverdueSentAt: integer("reminder_overdue_sent_at", {
      mode: "timestamp",
    }),
    decisionEmailSentAt: integer("decision_email_sent_at", {
      mode: "timestamp",
    }),
    submitterIp: text("submitter_ip"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("idx_research_apps_external_id").on(table.externalId),
    uniqueIndex("idx_research_apps_reference_code").on(table.referenceCode),
    index("idx_research_apps_status_created").on(
      table.status,
      table.createdAt
    ),
    index("idx_research_apps_pi_email").on(table.piEmail),
  ]
);

export const researchApplicationReferences = sqliteTable(
  "research_application_references",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: integer("application_id")
      .notNull()
      .references(() => researchApplications.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
  },
  (table) => [
    index("idx_research_refs_app_id").on(table.applicationId),
  ]
);

export const researchApplicationComments = sqliteTable(
  "research_application_comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: integer("application_id")
      .notNull()
      .references(() => researchApplications.id, { onDelete: "cascade" }),
    authorEmail: text("author_email").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_research_comments_app_id_created").on(
      table.applicationId,
      table.createdAt
    ),
  ]
);

export const researchReports = sqliteTable(
  "research_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: integer("application_id")
      .notNull()
      .references(() => researchApplications.id, { onDelete: "cascade" }),
    summary: text("summary"),
    driveFilesJson: text("drive_files_json"),
    submitterIp: text("submitter_ip"),
    submittedAt: integer("submitted_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_research_reports_app_id").on(table.applicationId),
  ]
);

// Types
export type ResearchApplication = typeof researchApplications.$inferSelect;
export type NewResearchApplication = typeof researchApplications.$inferInsert;

export type ResearchApplicationReference =
  typeof researchApplicationReferences.$inferSelect;
export type NewResearchApplicationReference =
  typeof researchApplicationReferences.$inferInsert;

export type ResearchApplicationComment =
  typeof researchApplicationComments.$inferSelect;
export type NewResearchApplicationComment =
  typeof researchApplicationComments.$inferInsert;

export type ResearchReport = typeof researchReports.$inferSelect;
export type NewResearchReport = typeof researchReports.$inferInsert;

// ---------------------------------------------------------------------------
// Grant Tracking (Seguimiento de Subsidios)
// ---------------------------------------------------------------------------

export const grantStatusEnum = [
  "to_research",
  "in_prep",
  "pending_decision",
  "funded",
  "rejected",
  "passed",
  "completed",
] as const;
export type GrantStatus = (typeof grantStatusEnum)[number];

export const funderPriorityEnum = ["highest", "high", "medium", "low"] as const;
export type FunderPriority = (typeof funderPriorityEnum)[number];

export const funders = sqliteTable(
  "funders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    // Lowercased/trimmed/de-"the"d name; unique key for reliable grant↔funder matching.
    nameNormalized: text("name_normalized").notNull(),
    website: text("website"),
    priority: text("priority", { enum: funderPriorityEnum }),
    funderType: text("funder_type"),
    focusAreas: text("focus_areas"),
    relationshipManager: text("relationship_manager"),
    relationshipStatus: text("relationship_status"),
    nextSteps: text("next_steps"),
    nextStepDue: integer("next_step_due", { mode: "timestamp" }),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    fundingHistory: text("funding_history"),
    description: text("description"),
    notes: text("notes"),
    irs990Link: text("irs990_link"),
    guidestarLink: text("guidestar_link"),
    foundationDirectoryLink: text("foundation_directory_link"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("idx_funders_name_normalized").on(table.nameNormalized),
    index("idx_funders_priority_name").on(table.priority, table.name),
  ]
);

export const grants = sqliteTable(
  "grants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    funderId: integer("funder_id").references(() => funders.id, {
      onDelete: "set null",
    }),
    // Original typed funder name; fallback display + manual-link target when funderId is null.
    funderNameRaw: text("funder_name_raw"),
    name: text("name").notNull(),
    website: text("website"),
    status: text("status", { enum: grantStatusEnum })
      .notNull()
      .default("to_research"),
    amountRequested: real("amount_requested"),
    amountAwarded: real("amount_awarded"),
    dueDate: integer("due_date", { mode: "timestamp" }),
    lastNotifiedAt: integer("last_notified_at", { mode: "timestamp" }),
    // Count of reminder thresholds (GRANT_REMINDER_DAYS) already emailed for this
    // grant. Each threshold fires once; the cron sends iff reminderLevel exceeds it.
    remindersSent: integer("reminders_sent").notNull().default(0),
    notes: text("notes"),
    folderLink: text("folder_link"),
    budgetLink: text("budget_link"),
    proposalLink: text("proposal_link"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_grants_status_due").on(table.status, table.dueDate),
    index("idx_grants_funder").on(table.funderId),
  ]
);

export type Funder = typeof funders.$inferSelect;
export type NewFunder = typeof funders.$inferInsert;
export type Grant = typeof grants.$inferSelect;
export type NewGrant = typeof grants.$inferInsert;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Standard ordering for camera trap images: EXIF timestamp -> file modified */
export const IMAGE_TIMESTAMP_ORDER = sql`COALESCE(${images.exifTimestamp}, ${images.fileModified})`;
