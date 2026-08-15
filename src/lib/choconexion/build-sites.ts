/**
 * Site records for the Choconexión bundle.
 *
 * Split the way the public overview snapshot is split: `assembleSites` is a pure
 * transform over injected query results so every rule here is unit-testable
 * without a database, and `loadSiteInputs` holds the SQL.
 *
 * The rules that matter, and why:
 *
 * - **Only human-confirmed identifications count.** `verified` and `corrected`
 *   only, with the effective label taken from `corrected_species` when present.
 *   Unreviewed model output never reaches a public artifact.
 * - **The effort window prefers the QA-validated dates.** `valid_start`/`valid_end`
 *   over `date_start`/`date_end`, matching how the public overview computes
 *   published effort — a camera that died early must count its real span. This
 *   is the whole reason the panel can put a 12-day plot beside a 31-day one.
 * - **State is decided here, not in the viewer.** A plot with an empty species
 *   list because nothing was uploaded and a plot with an empty species list
 *   because nothing was confirmed are different facts, and the viewer must not
 *   have to guess which it is holding.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { isWildSpecies } from "@/lib/species-filters";

import { PLOT_SITE_PAIRS, siteCodeFromDeploymentName } from "./plot-site-map";
import { isWithinPlotCluster, roundXY, toViewerXY } from "./geo";
import type {
  RosterSpecies,
  SiteRecord,
  SiteSpecies,
  SiteState,
  SiteWindow,
} from "./types";

// ---------------------------------------------------------------------------
// Input shapes (what the SQL returns)
// ---------------------------------------------------------------------------

export interface DeploymentRow {
  id: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  dateStart: string | null;
  dateEnd: string | null;
  validStart: string | null;
  validEnd: string | null;
  /** Rows in `biochoco_images` for this deployment. */
  imageRows: number;
  /** Rows in `biochoco_images` with status `processed`. */
  processedImages: number;
  /** Deployment-level counters; the Drive cache can undercount, so we take a max. */
  totalImages: number | null;
  uploadCameraCount: number | null;
}

export interface SpeciesTallyRow {
  deploymentId: number;
  /** `COALESCE(corrected_species, species)`. */
  eff: string;
  detections: number;
}

export interface SpeciesMetaRow {
  scientificName: string;
  commonName: string;
  spanishName: string | null;
  type: string;
  taxonomicRank: string | null;
}

export interface SiteInputs {
  deployments: DeploymentRow[];
  tallies: SpeciesTallyRow[];
  speciesMeta: Map<string, SpeciesMetaRow>;
}

// ---------------------------------------------------------------------------
// Window and duration
// ---------------------------------------------------------------------------

/**
 * The date part of a stored timestamp.
 *
 * Deployment dates are Ecuador local wall-clock with no offset — `2026-03-11`
 * or `2026-03-11T11:52`. Building a Date from these and reading it back in a
 * UTC container shifts the day, so the date is handled as a string throughout.
 */
export function datePart(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/** Whole calendar days between two `YYYY-MM-DD` dates. Negative spans return null. */
export function daysBetween(start: string, end: string): number | null {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const days = Math.round((b - a) / 86_400_000);
  return days < 0 ? null : days;
}

/**
 * The deployment window, preferring the QA-validated dates.
 *
 * An open deployment reports a null end and null duration rather than a span
 * computed to today — that would silently grow every time the bundle is rebuilt.
 * Note that a deployment can have a null `date_end` and still carry a validated
 * end, which is a real window and is reported as one.
 */
export function resolveWindow(dep: DeploymentRow): SiteWindow | null {
  const validStart = datePart(dep.validStart);
  const validEnd = datePart(dep.validEnd);
  const rawStart = datePart(dep.dateStart);
  const rawEnd = datePart(dep.dateEnd);

  const start = validStart ?? rawStart;
  if (!start) return null;

  const end = validEnd ?? rawEnd;
  const validated = Boolean(validStart || validEnd);

  return {
    start,
    end,
    days: end ? daysBetween(start, end) : null,
    validated,
  };
}

// ---------------------------------------------------------------------------
// Species naming
// ---------------------------------------------------------------------------

/**
 * Resolve the three name forms (R27), with the R29 fallback chain: a species
 * with no Spanish name falls back to English, and one with neither falls back to
 * the scientific name. The Spanish field stays null rather than being filled
 * with the English string, so the viewer can tell the difference.
 */
export function resolveNames(
  scientific: string,
  meta: SpeciesMetaRow | undefined,
): { scientific: string; english: string; spanish: string | null } {
  const english = meta?.commonName?.trim() || scientific;
  const spanish = meta?.spanishName?.trim() || null;
  return { scientific, english, spanish };
}

// ---------------------------------------------------------------------------
// State classification
// ---------------------------------------------------------------------------

/** How many images this site has uploaded, taking the most complete counter. */
export function uploadedCount(dep: DeploymentRow): number {
  return Math.max(
    dep.imageRows ?? 0,
    dep.totalImages ?? 0,
    dep.uploadCameraCount ?? 0,
  );
}

export function classifyState(
  dep: DeploymentRow | undefined,
  wildSpeciesCount: number,
): SiteState {
  // A mapped plot whose site has no deployment row at all — P08 today.
  if (!dep) return "no-data";
  if (uploadedCount(dep) === 0) return "no-data";
  if ((dep.processedImages ?? 0) === 0) return "unprocessed";
  return wildSpeciesCount > 0 ? "results" : "no-species";
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleResult {
  sites: SiteRecord[];
  species: RosterSpecies[];
  /** Non-fatal problems worth surfacing to the operator before they commit. */
  warnings: string[];
}

/**
 * Build every site record and the experiment-wide roster.
 *
 * Pure: no database, no clock, no filesystem. Photos and soundscape are left
 * empty here and filled by the media steps, so this stays testable on its own.
 */
export function assembleSites(inputs: SiteInputs): AssembleResult {
  const { deployments, tallies, speciesMeta } = inputs;
  const warnings: string[] = [];

  const bySiteCode = new Map<string, DeploymentRow>();
  for (const dep of deployments) {
    const code = siteCodeFromDeploymentName(dep.name);
    const existing = bySiteCode.get(code);
    // A site with more than one deployment keeps the most recent; the
    // experiment has one visit per site today, so this is a guard, not a path.
    if (existing) {
      warnings.push(
        `${code} tiene más de un despliegue (${existing.id}, ${dep.id}); se usa el más reciente.`,
      );
      if (dep.id < existing.id) continue;
    }
    bySiteCode.set(code, dep);
  }

  const talliesByDeployment = new Map<number, SpeciesTallyRow[]>();
  for (const row of tallies) {
    const list = talliesByDeployment.get(row.deploymentId);
    if (list) list.push(row);
    else talliesByDeployment.set(row.deploymentId, [row]);
  }

  const roster = new Map<string, { plots: number; detections: number }>();
  const sites: SiteRecord[] = [];

  for (const { plotId, siteCode } of PLOT_SITE_PAIRS) {
    const dep = bySiteCode.get(siteCode);

    const wild: SiteSpecies[] = [];
    if (dep) {
      for (const row of talliesByDeployment.get(dep.id) ?? []) {
        const meta = speciesMeta.get(row.eff);
        if (!isWildSpecies(meta, row.eff)) continue;
        wild.push({ ...resolveNames(row.eff, meta), detections: row.detections });
      }
    }
    // Richest first, scientific name as a stable tiebreaker so re-exports of
    // unchanged data produce no diff.
    wild.sort(
      (a, b) =>
        b.detections - a.detections || a.scientific.localeCompare(b.scientific),
    );

    for (const sp of wild) {
      const entry = roster.get(sp.scientific) ?? { plots: 0, detections: 0 };
      entry.plots += 1;
      entry.detections += sp.detections;
      roster.set(sp.scientific, entry);
    }

    const state = classifyState(dep, wild.length);

    let x: number | null = null;
    let y: number | null = null;
    if (dep && dep.latitude != null && dep.longitude != null) {
      const xy = roundXY(toViewerXY(dep.latitude, dep.longitude));
      if (isWithinPlotCluster(xy)) {
        x = xy.x;
        y = xy.y;
      } else {
        warnings.push(
          `${siteCode} (${plotId}) se reproyecta fuera del conjunto de parcelas; se omite la posición.`,
        );
      }
    } else if (dep) {
      warnings.push(`${siteCode} (${plotId}) no tiene coordenadas registradas.`);
    }

    sites.push({
      plotId,
      siteCode,
      state,
      x,
      y,
      window: dep ? resolveWindow(dep) : null,
      species: state === "results" ? wild : [],
      photos: [],
      soundscapes: [],
      pendingImages:
        state === "unprocessed" && dep
          ? uploadedCount(dep) - (dep.processedImages ?? 0)
          : null,
    });
  }

  const species: RosterSpecies[] = [...roster.entries()]
    .map(([scientific, agg]) => ({
      ...resolveNames(scientific, speciesMeta.get(scientific)),
      plots: agg.plots,
      detections: agg.detections,
    }))
    .sort(
      (a, b) =>
        b.detections - a.detections || a.scientific.localeCompare(b.scientific),
    );

  return { sites, species, warnings };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * Read everything `assembleSites` needs, scoped to the 16 mapped sites.
 *
 * Site codes are matched with `LIKE '<code>%'` against the deployment name,
 * mirroring how the site code is derived from the name elsewhere.
 */
export async function loadSiteInputs(): Promise<SiteInputs> {
  const codes = PLOT_SITE_PAIRS.map((p) => p.siteCode);
  // An OR chain of prefix matches. A single `IN` will not do: the deployment
  // name carries a visit suffix (`REF-007_V1`), so the match is by prefix.
  const nameMatches = sql.join(
    codes.map((c) => sql`d.name LIKE ${`${c}%`}`),
    sql` OR `,
  );

  const deployments = await db.all<DeploymentRow>(sql`
    SELECT
      d.id                                            AS id,
      d.name                                          AS name,
      d.latitude                                      AS latitude,
      d.longitude                                     AS longitude,
      d.date_start                                    AS dateStart,
      d.date_end                                      AS dateEnd,
      d.valid_start                                   AS validStart,
      d.valid_end                                     AS validEnd,
      d.total_images                                  AS totalImages,
      d.upload_camera_count                           AS uploadCameraCount,
      (SELECT COUNT(*) FROM biochoco_images i
         WHERE i.deployment_id = d.id)                AS imageRows,
      (SELECT COUNT(*) FROM biochoco_images i
         WHERE i.deployment_id = d.id
           AND i.status = 'processed')                AS processedImages
    FROM biochoco_deployments d
    WHERE (d.excluded_camera IS NULL OR d.excluded_camera = 0)
      AND (${nameMatches})
    ORDER BY d.id`);

  // `IN ()` is a syntax error in SQLite, so an empty scope skips the query
  // rather than building one. Reachable on a database with none of the sites.
  const tallies = deployments.length
    ? await db.all<SpeciesTallyRow>(sql`
        SELECT
          img.deployment_id                            AS deploymentId,
          COALESCE(i.corrected_species, i.species)     AS eff,
          COUNT(*)                                     AS detections
        FROM biochoco_identifications i
        JOIN biochoco_detections det ON det.id = i.detection_id
        JOIN biochoco_images img     ON img.id = det.image_id
        WHERE i.verification_status IN ('verified', 'corrected')
          AND img.deployment_id IN (${sql.join(
            deployments.map((d) => sql`${d.id}`),
            sql`, `,
          )})
        GROUP BY img.deployment_id, eff`)
    : [];

  const metaRows = await db.all<SpeciesMetaRow>(sql`
    SELECT
      scientific_name AS scientificName,
      common_name     AS commonName,
      spanish_name    AS spanishName,
      type            AS type,
      taxonomic_rank  AS taxonomicRank
    FROM biochoco_species`);

  return {
    deployments,
    tallies,
    speciesMeta: new Map(metaRows.map((m) => [m.scientificName, m])),
  };
}
