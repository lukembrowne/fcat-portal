/**
 * Bundle assembly for the Choconexión export.
 *
 * Auth-agnostic and callable without a request context, the same split the
 * audio-compression core uses. Its one caller is the CLI exporter
 * (`scripts/export-choconexion-bundle.ts`), driven by
 * `scripts/refresh-choconexion-bundle.sh`: the bundle is built on a laptop from
 * a snapshot of the production database and committed to the Choconexión repo,
 * so refreshing the viewer's data never requires deploying this portal.
 *
 * The output is a self-contained directory. Once the operator unpacks it into
 * the Choconexión repo, the public site serves it as static files and never
 * calls the portal — which is the property that keeps the viewer working while
 * this portal is down.
 */

import "server-only";

import path from "node:path";
import { promises as fs } from "node:fs";

import pLimit from "p-limit";

import { log } from "@/lib/log";
import { downloadFileToBuffer } from "@/lib/drive-client";

import { assembleSites, loadSiteInputs } from "./build-sites";
import { siteCodeFromDeploymentName } from "./plot-site-map";
import { exportSitePhotos, loadPhotoCandidates } from "./photos";
import { exportSiteSoundscapes, loadSoundscapeCandidates } from "./soundscape";
import {
  BUNDLE_CRS,
  BUNDLE_SCHEMA_VERSION,
  type ChoconexionBundle,
  type SiteRecord,
} from "./types";

/** Where bundles are written inside the portal's data volume. */
export const EXPORT_ROOT = path.join(process.cwd(), "data", "exports", "choconexion");

/**
 * A version is a date, optionally with a `-N` suffix when more than one bundle
 * is produced in a day. This pattern is the only shape ever joined onto a path.
 */
export const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}(-\d+)?$/;

/** Drive fetches in flight at once. Bounded to stay a polite API citizen. */
const FETCH_CONCURRENCY = 4;

export interface ExportProgress {
  (done: number, total: number, message: string): void | Promise<void>;
}

export interface BuildBundleOptions {
  /** Version//directory name; must match VERSION_PATTERN. */
  version: string;
  /** Injected so the export is reproducible in a test. */
  now?: Date;
  onProgress?: ExportProgress;
  /** Injected for tests; defaults to the real Drive client. */
  fetchFile?: (driveFileId: string) => Promise<Buffer>;
}

export interface BuildBundleResult {
  version: string;
  /** Absolute path to the bundle directory. */
  dir: string;
  bundle: ChoconexionBundle;
  warnings: string[];
  /** Total bytes written, so the operator sees what the repo is about to take. */
  bytes: number;
}

export function isValidVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

/** The bundle directory for a version, refusing anything that isn't one. */
export function resolveVersionDir(version: string): string {
  if (!isValidVersion(version)) {
    throw new Error(`Versión inválida: ${version}`);
  }
  return path.join(EXPORT_ROOT, version);
}

/** The next unused version for a day, so two exports never collide. */
export async function nextVersion(now: Date): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  let candidate = day;
  let n = 1;
  // Bounded: a hundred exports in one day is already pathological.
  while (n < 100) {
    try {
      await fs.access(path.join(EXPORT_ROOT, candidate));
    } catch {
      return candidate;
    }
    n += 1;
    candidate = `${day}-${n}`;
  }
  throw new Error("Demasiados exportes hoy.");
}

/**
 * Build the whole bundle: site records, photographs, soundscape clips, and the
 * `sites.json` that ties them together.
 *
 * Media failures are isolated per site. A site whose photographs cannot be
 * fetched still ships its record, its window and its species list — losing a
 * strip is much better than losing a marker.
 */
export async function buildBundle({
  version,
  now = new Date(),
  onProgress,
  fetchFile = downloadFileToBuffer,
}: BuildBundleOptions): Promise<BuildBundleResult> {
  const dir = resolveVersionDir(version);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  await onProgress?.(0, 1, "Leyendo la base de datos…");

  const inputs = await loadSiteInputs();
  const { sites, species, warnings } = assembleSites(inputs);

  const deploymentIds = inputs.deployments.map((d) => d.id);
  const [photoCandidates, soundCandidates] = await Promise.all([
    loadPhotoCandidates(deploymentIds, inputs.speciesMeta),
    loadSoundscapeCandidates(deploymentIds),
  ]);

  const depBySiteCode = new Map(
    inputs.deployments.map((d) => [siteCodeFromDeploymentName(d.name), d.id]),
  );

  const limit = pLimit(FETCH_CONCURRENCY);
  const total = sites.length;
  let done = 0;

  const mediaWarnings: string[] = [];

  await Promise.all(
    sites.map((site) =>
      limit(async () => {
        const deploymentId = depBySiteCode.get(site.siteCode);
        if (deploymentId != null) {
          await attachMedia({
            site,
            deploymentId,
            dir,
            photoCandidates,
            soundCandidates,
            fetchFile,
            warnings: mediaWarnings,
          });
        }

        done += 1;
        await onProgress?.(done, total, `Sitios procesados: ${done}/${total}`);
      }),
    ),
  );

  // Site order follows the plot order, not the order media finished.
  sites.sort((a, b) => a.plotId.localeCompare(b.plotId));

  const bundle: ChoconexionBundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    generatedAt: now.toISOString().slice(0, 10),
    crs: BUNDLE_CRS,
    sites,
    species,
  };

  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "data", "sites.json"),
    `${JSON.stringify(bundle, null, 1)}\n`,
    "utf8",
  );

  const bytes = await directorySize(dir);
  const allWarnings = [...warnings, ...mediaWarnings];

  log.info(
    {
      version,
      sites: sites.length,
      species: species.length,
      photos: sites.reduce((n, s) => n + s.photos.length, 0),
      clips: sites.reduce((n, s) => n + s.soundscapes.length, 0),
      sitesWithAudio: sites.filter((s) => s.soundscapes.length > 0).length,
      megabytes: (bytes / 1024 / 1024).toFixed(1),
      warnings: allWarnings.length,
    },
    "[choconexion] bundle built",
  );

  return { version, dir, bundle, warnings: allWarnings, bytes };
}

interface AttachMediaArgs {
  site: SiteRecord;
  deploymentId: number;
  dir: string;
  photoCandidates: Awaited<ReturnType<typeof loadPhotoCandidates>>;
  soundCandidates: Awaited<ReturnType<typeof loadSoundscapeCandidates>>;
  fetchFile: (driveFileId: string) => Promise<Buffer>;
  warnings: string[];
}

async function attachMedia({
  site,
  deploymentId,
  dir,
  photoCandidates,
  soundCandidates,
  fetchFile,
  warnings,
}: AttachMediaArgs): Promise<void> {
  const siteDir = path.join(dir, "sites", site.siteCode);
  const publicPrefix = `sites/${site.siteCode}`;

  // The ranking is the only authority on what qualifies: it admits starred or
  // identified frames and returns nothing otherwise. Gating on `state` here
  // instead would silently drop a starred frame at a site where nothing was
  // confirmed — and a human star is exactly the signal worth keeping there.
  const { photos, warnings: photoWarnings } = await exportSitePhotos({
    siteCode: site.siteCode,
    candidates: photoCandidates.get(deploymentId) ?? [],
    outDir: path.join(siteDir, "photos"),
    publicPrefix: `${publicPrefix}/photos`,
    fetchImage: fetchFile,
  });
  site.photos = photos;
  warnings.push(...photoWarnings);

  const { soundscapes, warnings: audioWarnings } = await exportSiteSoundscapes({
    siteCode: site.siteCode,
    candidates: soundCandidates.get(deploymentId) ?? [],
    outDir: siteDir,
    publicPrefix,
    fetchAudio: fetchFile,
  });
  site.soundscapes = soundscapes;
  warnings.push(...audioWarnings);
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else total += (await fs.stat(full)).size;
  }
  return total;
}
