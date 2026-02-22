/**
 * Camtrap DP Export API
 *
 * Generates a Camtrap DP-compliant ZIP containing:
 *   - deployments.csv
 *   - media.csv
 *   - observations.csv
 *   - datapackage.json
 *
 * Usage:
 *   GET /api/camera-trap/export?ids=1,2,3
 */

import { NextRequest, NextResponse } from "next/server";
import { deflateRawSync } from "node:zlib";
import { db } from "@/db";
import {
  deployments,
  images,
  videos,
  detections,
  identifications,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getUserCameraTrapProjects, ctProjectFilter } from "@/lib/camera-trap-auth";
import { eq, inArray, and, ne, isNull, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

const MAX_IDS = 500;
const PROCESSED_STATUSES = ["processed", "verified", "verified_empty"] as const;

// ── Helpers ──────────────────────────────────────────────────────────────

function csvVal(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined || val === "") return "";
  const str = String(val);
  return `"${str.replace(/"/g, '""')}"`;
}

function rowsToCsv(
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][]
): string {
  return (
    "\uFEFF" +
    [headers.join(","), ...rows.map((row) => row.map(csvVal).join(","))].join(
      "\n"
    )
  );
}

/** Ensure ISO 8601 datetime. If date-only (YYYY-MM-DD), append T00:00:00Z. */
function toISO(val: string | Date | null | undefined): string {
  if (!val) return "";
  const s = val instanceof Date ? val.toISOString() : String(val);
  // Already has a time component
  if (s.includes("T")) return s;
  // Date-only → append midnight UTC
  return `${s}T00:00:00Z`;
}

/** Map MegaDetector detection class to Camtrap DP observationType. */
function observationTypeFromClass(cls: number): string {
  switch (cls) {
    case 2:
      return "human";
    case 3:
      return "vehicle";
    default:
      return "animal"; // 0 (manual) and 1 (animal)
  }
}

// ── Route Handler ────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // Auth
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const hasAccess =
    user.globalRole === "super_admin" ||
    user.permissions.some((p) => p.projectId === "camera-trap");
  if (!hasAccess) {
    return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  }

  // Parse & validate IDs
  const idsParam = request.nextUrl.searchParams.get("ids");
  if (!idsParam) {
    return NextResponse.json(
      { error: "Parámetro 'ids' requerido" },
      { status: 400 }
    );
  }

  const ids = idsParam
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);

  if (ids.length === 0) {
    return NextResponse.json(
      { error: "No se proporcionaron IDs válidos" },
      { status: 400 }
    );
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `Máximo ${MAX_IDS} instalaciones por exportación` },
      { status: 400 }
    );
  }

  // CT project-level access: filter requested IDs to accessible projects
  const ctProjects = await getUserCameraTrapProjects(user);
  const projectAccessFilter = ctProjectFilter(ctProjects);

  // ── Query 1: Deployments ─────────────────────────────────────────────

  const deploymentRows = await db
    .select()
    .from(deployments)
    .where(
      and(
        inArray(deployments.id, ids),
        inArray(deployments.status, PROCESSED_STATUSES),
        projectAccessFilter,
      )
    );

  if (deploymentRows.length === 0) {
    return NextResponse.json(
      { error: "No hay instalaciones procesadas para exportar" },
      { status: 400 }
    );
  }

  const validIds = deploymentRows.map((d) => d.id);

  // ── Query 2: Media (images + video info) ─────────────────────────────

  const mediaRows = await db
    .select({
      id: images.id,
      deploymentId: images.deploymentId,
      filename: images.filename,
      exifTimestamp: images.exifTimestamp,
      fileModified: images.fileModified,
      videoId: images.videoId,
      frameIndex: images.frameIndex,
      confirmedBlank: images.confirmedBlank,
      videoFilename: videos.filename,
    })
    .from(images)
    .leftJoin(videos, eq(images.videoId, videos.id))
    .where(inArray(images.deploymentId, validIds));

  // Build a map of deploymentId → dateStart for timestamp fallback
  const deploymentDateMap = new Map(
    deploymentRows.map((d) => [d.id, d.dateStart])
  );

  // ── Query 3: Observations (detections + identifications) ─────────────

  const observationRows = await db
    .select({
      detectionId: detections.id,
      imageId: detections.imageId,
      bboxX: detections.bboxX,
      bboxY: detections.bboxY,
      bboxWidth: detections.bboxWidth,
      bboxHeight: detections.bboxHeight,
      detectionConfidence: detections.detectionConfidence,
      detectionClass: detections.detectionClass,
      detectionModelVersion: detections.modelVersion,
      identificationId: identifications.id,
      species: identifications.species,
      correctedSpecies: identifications.correctedSpecies,
      confidence: identifications.confidence,
      identModelVersion: identifications.modelVersion,
      verificationStatus: identifications.verificationStatus,
      verifiedBy: identifications.verifiedBy,
    })
    .from(detections)
    .innerJoin(images, eq(detections.imageId, images.id))
    .leftJoin(identifications, eq(identifications.detectionId, detections.id))
    .where(
      and(
        inArray(images.deploymentId, validIds),
        or(
          isNull(identifications.verificationStatus),
          ne(identifications.verificationStatus, "rejected")
        )
      )
    );

  // Build image→deploymentId lookup
  const imageDeploymentMap = new Map(
    mediaRows.map((m) => [m.id, m.deploymentId])
  );
  // Build image→timestamp lookup
  const imageTimestampMap = new Map(
    mediaRows.map((m) => [
      m.id,
      m.exifTimestamp ??
        (m.fileModified ? m.fileModified.toISOString() : null) ??
        deploymentDateMap.get(m.deploymentId) ??
        null,
    ])
  );

  // ── Build deployments.csv ────────────────────────────────────────────

  const deploymentsHeaders = [
    "deploymentID",
    "locationID",
    "locationName",
    "latitude",
    "longitude",
    "deploymentStart",
    "deploymentEnd",
    "deploymentComments",
  ];

  const deploymentsRows = deploymentRows.map((d) => [
    String(d.id),
    d.siteName,
    d.name,
    d.latitude,
    d.longitude,
    toISO(d.dateStart),
    toISO(d.dateEnd),
    d.projectLabel,
  ]);

  const deploymentsCsv = rowsToCsv(deploymentsHeaders, deploymentsRows);

  // ── Build media.csv ──────────────────────────────────────────────────

  const mediaHeaders = [
    "mediaID",
    "deploymentID",
    "captureMethod",
    "timestamp",
    "filePath",
    "filePublic",
    "fileName",
    "fileMediatype",
    "mediaComments",
  ];

  const mediaCsvRows = mediaRows.map((m) => {
    const isVideoFrame = m.videoId != null;
    const timestamp =
      m.exifTimestamp ??
      (m.fileModified ? m.fileModified.toISOString() : null) ??
      deploymentDateMap.get(m.deploymentId) ??
      null;

    return [
      String(m.id),
      String(m.deploymentId),
      isVideoFrame ? "activityDetection" : null,
      toISO(timestamp),
      m.filename,
      false,
      m.filename,
      "image/jpeg",
      isVideoFrame
        ? `Extracted from video: ${m.videoFilename ?? "unknown"}, frame ${m.frameIndex ?? 0}`
        : null,
    ];
  });

  const mediaCsv = rowsToCsv(mediaHeaders, mediaCsvRows);

  // ── Build observations.csv ───────────────────────────────────────────

  const obsHeaders = [
    "observationID",
    "deploymentID",
    "mediaID",
    "eventStart",
    "eventEnd",
    "observationLevel",
    "observationType",
    "scientificName",
    "count",
    "bboxX",
    "bboxY",
    "bboxWidth",
    "bboxHeight",
    "classificationMethod",
    "classifiedBy",
    "classificationProbability",
  ];

  // Track which images have at least one non-rejected observation
  const imagesWithObservations = new Set<number>();

  const detectionObsRows = observationRows.map((o) => {
    imagesWithObservations.add(o.imageId);

    const obsType = observationTypeFromClass(o.detectionClass);
    const effectiveSpecies = o.correctedSpecies ?? o.species ?? null;
    const isHumanVerified =
      o.verificationStatus === "verified" ||
      o.verificationStatus === "corrected";

    return [
      `det-${o.detectionId}`,
      String(imageDeploymentMap.get(o.imageId) ?? ""),
      String(o.imageId),
      toISO(imageTimestampMap.get(o.imageId)),
      toISO(imageTimestampMap.get(o.imageId)),
      "media",
      obsType,
      obsType === "animal" ? effectiveSpecies : null,
      1,
      o.bboxX,
      o.bboxY,
      o.bboxWidth,
      o.bboxHeight,
      isHumanVerified ? "human" : "machine",
      isHumanVerified
        ? o.verifiedBy
        : (o.identModelVersion ?? o.detectionModelVersion),
      o.confidence,
    ];
  });

  // Blank observations for images with no detections or confirmedBlank
  const blankObsRows = mediaRows
    .filter(
      (m) => !imagesWithObservations.has(m.id) || m.confirmedBlank === true
    )
    // Don't double-count: if confirmedBlank but already in imagesWithObservations,
    // only add if it wasn't already excluded
    .filter((m) => {
      if (m.confirmedBlank && imagesWithObservations.has(m.id)) {
        // This image has non-rejected detections AND is confirmedBlank.
        // Edge case: confirmedBlank means all were batch-rejected, so
        // if we still have non-rejected observations it's inconsistent.
        // Skip the blank row — the detection rows are already there.
        return false;
      }
      return true;
    })
    .map((m) => {
      const ts = imageTimestampMap.get(m.id);
      return [
        `blank-${m.id}`,
        String(m.deploymentId),
        String(m.id),
        toISO(ts),
        toISO(ts),
        "media",
        "blank",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
    });

  const observationsCsv = rowsToCsv(obsHeaders, [
    ...detectionObsRows,
    ...blankObsRows,
  ]);

  // ── Build datapackage.json ───────────────────────────────────────────

  const dates = deploymentRows
    .flatMap((d) => [d.dateStart, d.dateEnd])
    .filter(Boolean) as string[];
  dates.sort();

  const datapackage = {
    profile:
      "https://rs.gbif.org/sandbox/data-packages/camtrap-dp/1.0/profile/camtrap-dp-profile.json",
    name: "fcat-camera-trap-export",
    title: "FCAT Camera Trap Data Export",
    created: new Date().toISOString(),
    licenses: [
      {
        name: "CC-BY-4.0",
        path: "https://creativecommons.org/licenses/by/4.0/",
      },
    ],
    project: {
      title: "FCAT Camera Trap Monitoring",
      description:
        "Camera trap monitoring program by Fundación para la Conservación de los Andes Tropicales (FCAT), Ecuador.",
    },
    ...(dates.length > 0 && {
      temporal: {
        start: dates[0],
        end: dates[dates.length - 1],
      },
    }),
    resources: [
      { name: "deployments", path: "deployments.csv" },
      { name: "media", path: "media.csv" },
      { name: "observations", path: "observations.csv" },
    ],
  };

  // ── ZIP & Response ───────────────────────────────────────────────────

  const zipData = createZip({
    "deployments.csv": deploymentsCsv,
    "media.csv": mediaCsv,
    "observations.csv": observationsCsv,
    "datapackage.json": JSON.stringify(datapackage, null, 2),
  });

  const date = new Date().toISOString().split("T")[0];

  return new Response(new Uint8Array(zipData), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="camtrap-dp-${date}.zip"`,
    },
  });
}

// ── Minimal ZIP builder using Node.js built-in zlib ──────────────────

function createZip(files: Record<string, string>): Buffer {
  const entries = Object.entries(files);
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf-8");
    const raw = Buffer.from(content, "utf-8");
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);

    // Local file header (30 bytes + name + compressed data)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // compression: deflate
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0, 12);          // mod date
    local.writeUInt32LE(crc, 14);        // crc-32
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22);        // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);  // filename length
    local.writeUInt16LE(0, 28);                 // extra field length
    nameBytes.copy(local, 30);
    localHeaders.push(local, compressed);

    // Central directory header (46 bytes + name)
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);  // signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);           // flags
    central.writeUInt16LE(8, 10);          // compression: deflate
    central.writeUInt16LE(0, 12);          // mod time
    central.writeUInt16LE(0, 14);          // mod date
    central.writeUInt32LE(crc, 16);        // crc-32
    central.writeUInt32LE(compressed.length, 20); // compressed size
    central.writeUInt32LE(raw.length, 24);        // uncompressed size
    central.writeUInt16LE(nameBytes.length, 28);  // filename length
    central.writeUInt16LE(0, 30);          // extra field length
    central.writeUInt16LE(0, 32);          // comment length
    central.writeUInt16LE(0, 34);          // disk number start
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE(0, 38);          // external attrs
    central.writeUInt32LE(offset, 42);     // local header offset
    nameBytes.copy(central, 46);
    centralHeaders.push(central);

    offset += local.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralHeaders);

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);         // signature
  eocd.writeUInt16LE(0, 4);                  // disk number
  eocd.writeUInt16LE(0, 6);                  // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);     // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);    // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(offset, 16);            // central dir offset
  eocd.writeUInt16LE(0, 20);                 // comment length

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
