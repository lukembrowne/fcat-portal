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
    uploadCameraFolderId: text("upload_camera_folder_id"),
    uploadAudioFolderId: text("upload_audio_folder_id"),
    uploadIbuttonFolderId: text("upload_ibutton_folder_id"),
    uploadCountsCheckedAt: integer("upload_counts_checked_at", { mode: "timestamp" }),
    // Upload cache — file sizes (bytes) and newest file dates
    uploadCameraSizeBytes: integer("upload_camera_size_bytes"),
    uploadAudioSizeBytes: integer("upload_audio_size_bytes"),
    uploadIbuttonSizeBytes: integer("upload_ibutton_size_bytes"),
    uploadNewestCameraDate: text("upload_newest_camera_date"),
    uploadNewestAudioDate: text("upload_newest_audio_date"),
    uploadNewestIbuttonDate: text("upload_newest_ibutton_date"),
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
  ]
);

// ---------------------------------------------------------------------------
// Processing Jobs
// ---------------------------------------------------------------------------

export const processingJobs = sqliteTable("biochoco_processing_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deploymentId: integer("deployment_id")
    .notNull()
    .references(() => deployments.id, { onDelete: "cascade" }),
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
  },
  (table) => [
    index("idx_biochoco_identifications_detection_id").on(table.detectionId),
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
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_audio_detections_file").on(table.audioFileId),
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

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Standard ordering for camera trap images: EXIF timestamp -> file modified */
export const IMAGE_TIMESTAMP_ORDER = sql`COALESCE(${images.exifTimestamp}, ${images.fileModified})`;
