/**
 * Database Schema for FCAT Portal
 *
 * Tables:
 * - users, projects, user_permissions (auth/permissions)
 * - deployments, processing_jobs, images, detections, identifications, species (camera trap)
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
// Deployments
// ---------------------------------------------------------------------------

export const deployments = sqliteTable(
  "deployments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    name: text("name").notNull(),
    latitude: real("latitude"),
    longitude: real("longitude"),
    dateStart: text("date_start"),
    dateEnd: text("date_end"),
    totalImages: integer("total_images").default(0),
    status: text("status", {
      enum: ["unscanned", "scanned", "processing", "processed", "verified"],
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
  },
  (table) => [
    uniqueIndex("idx_deployments_project_path").on(
      table.projectId,
      table.path
    ),
  ]
);

// ---------------------------------------------------------------------------
// Processing Jobs
// ---------------------------------------------------------------------------

export const processingJobs = sqliteTable("processing_jobs", {
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
  pid: integer("pid"),
  totalImages: integer("total_images").notNull().default(0),
  processedImages: integer("processed_images").notNull().default(0),
  failedImages: integer("failed_images").notNull().default(0),
  errorMessage: text("error_message"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  createdBy: text("created_by"),
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const images = sqliteTable(
  "images",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deploymentId: integer("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    jobId: integer("job_id").references(() => processingJobs.id, {
      onDelete: "set null",
    }),
    filename: text("filename").notNull(),
    path: text("path").notNull(),
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
  },
  (table) => [
    index("idx_images_deployment_id").on(table.deploymentId),
    index("idx_images_job_id").on(table.jobId),
  ]
);

// ---------------------------------------------------------------------------
// Detections (bounding boxes from MegaDetector)
// ---------------------------------------------------------------------------

export const detections = sqliteTable(
  "detections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    imageId: integer("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    jobId: integer("job_id")
      .notNull()
      .references(() => processingJobs.id, { onDelete: "cascade" }),
    bboxX: real("bbox_x").notNull(),
    bboxY: real("bbox_y").notNull(),
    bboxWidth: real("bbox_width").notNull(),
    bboxHeight: real("bbox_height").notNull(),
    detectionConfidence: real("detection_confidence").notNull(),
    detectionClass: integer("detection_class").notNull().default(0),
    modelVersion: text("model_version"),
  },
  (table) => [
    index("idx_detections_image_id").on(table.imageId),
    index("idx_detections_job_id").on(table.jobId),
  ]
);

// ---------------------------------------------------------------------------
// Identifications (species classification per detection)
// ---------------------------------------------------------------------------

export const identifications = sqliteTable(
  "identifications",
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
    index("idx_identifications_detection_id").on(table.detectionId),
  ]
);

// ---------------------------------------------------------------------------
// Species Lookup Table
// ---------------------------------------------------------------------------

export const species = sqliteTable("species", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scientificName: text("scientific_name").notNull().unique(),
  commonName: text("common_name").notNull(),
  type: text("type", {
    enum: ["mammal", "bird", "reptile", "amphibian", "insect", "system"],
  })
    .notNull()
    .default("mammal"),
});

// ---------------------------------------------------------------------------
// Type Exports
// ---------------------------------------------------------------------------

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

export type Detection = typeof detections.$inferSelect;
export type NewDetection = typeof detections.$inferInsert;

export type Identification = typeof identifications.$inferSelect;
export type NewIdentification = typeof identifications.$inferInsert;

export type Species = typeof species.$inferSelect;
export type NewSpecies = typeof species.$inferInsert;
