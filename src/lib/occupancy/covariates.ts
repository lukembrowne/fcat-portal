/**
 * Site covariate assembly for occupancy models.
 *
 * Produces the `CovariateSpec[]` that `assembleRunConfig` consumes, from three
 * sources per site:
 *   - forest-cover proportion + elevation — from the raster pipeline (U3), or
 *   - habitat type — from ODK habitat assessments, or
 *   - a dev fallback: values embedded in the seeder's `field_notes.occSeed` blob
 *     (see scripts/seed-occupancy-dev.ts) so the full pipeline is exercisable
 *     locally without the Planet raster / ODK.
 *
 * A covariate is only emitted when EVERY modeled site has a value for it —
 * `unmarked` cannot fit a site covariate with missing rows. Covariates available
 * for only some sites are dropped with a recorded reason (surfaced on the page).
 */
import type BetterSqlite3 from "better-sqlite3";
import type { CovariateSpec } from "./config";

export interface SiteCovariateInput {
  siteId: string;
  siteName: string;
  /** Raw deployment name (e.g. "NAC-014_V1") — used to join ODK habitat. */
  deploymentName: string;
  latitude: number | null;
  longitude: number | null;
  /** Deployment field_notes — may carry the dev seeder's occSeed blob. */
  fieldNotes: string | null;
}

/** Resolvers for real (non-seed) sites: raster forest/elevation, ODK habitat. */
export interface CovariateResolvers {
  forestCover?: (siteId: string) => number | null | undefined;
  elevation?: (siteId: string) => number | null | undefined;
  habitat?: (siteId: string) => string | null | undefined;
}

export interface RawSiteCovariates {
  siteId: string;
  siteName: string;
  latitude: number | null;
  longitude: number | null;
  habitat: string | null;
  elevation: number | null;
  forestCover: number | null;
}

/** Parse the dev seeder's embedded covariates from field_notes, if present. */
export function parseSeedCovariates(
  fieldNotes: string | null | undefined,
): { forest: number; elevation: number; habitat?: string } | null {
  if (!fieldNotes) return null;
  try {
    const parsed = JSON.parse(fieldNotes);
    const s = parsed?.occSeed;
    if (s && typeof s.forest === "number") return s;
    return null;
  } catch {
    return null;
  }
}

/** Resolve raw covariate values per site (dev seed blob first, then resolvers). */
export function resolveSiteCovariates(
  sites: SiteCovariateInput[],
  resolvers: CovariateResolvers = {},
): RawSiteCovariates[] {
  return sites.map((s) => {
    const seed = parseSeedCovariates(s.fieldNotes);
    const forestCover = seed
      ? seed.forest
      : (resolvers.forestCover?.(s.siteId) ?? null);
    const elevation = seed
      ? seed.elevation
      : (resolvers.elevation?.(s.siteId) ?? null);
    const habitat = seed
      ? seed.habitat
      : (resolvers.habitat?.(s.siteId) ?? null);
    return {
      siteId: s.siteId,
      siteName: s.siteName,
      latitude: s.latitude,
      longitude: s.longitude,
      forestCover: forestCover ?? null,
      elevation: elevation ?? null,
      habitat: habitat ?? null,
    };
  });
}

export interface CovariateSpecResult {
  covariates: CovariateSpec[];
  dropped: { name: string; reason: string }[];
}

/**
 * Turn per-site raw covariates into `CovariateSpec[]`, keeping only covariates
 * present for ALL sites. Order: forest cover, elevation (continuous), then
 * habitat (factor) — matches the occupancy (state) formula order.
 */
export function toCovariateSpecs(raw: RawSiteCovariates[]): CovariateSpecResult {
  const covariates: CovariateSpec[] = [];
  const dropped: { name: string; reason: string }[] = [];
  const n = raw.length;

  const forest = raw.map((r) => r.forestCover);
  if (forest.every((v) => v != null)) {
    covariates.push({ name: "forest", kind: "continuous", values: forest as number[] });
  } else {
    dropped.push({
      name: "forest",
      reason: `cobertura boscosa ausente en ${forest.filter((v) => v == null).length}/${n} sitios`,
    });
  }

  const elev = raw.map((r) => r.elevation);
  if (elev.every((v) => v != null)) {
    covariates.push({ name: "elevation", kind: "continuous", values: elev as number[] });
  } else {
    dropped.push({
      name: "elevation",
      reason: `elevación ausente en ${elev.filter((v) => v == null).length}/${n} sitios`,
    });
  }

  const hab = raw.map((r) => r.habitat);
  if (hab.every((v) => v != null && v !== "")) {
    covariates.push({ name: "habitat", kind: "factor", values: hab as string[] });
  } else {
    dropped.push({
      name: "habitat",
      reason: `tipo de hábitat ausente en ${hab.filter((v) => v == null || v === "").length}/${n} sitios`,
    });
  }

  return { covariates, dropped };
}

/** Persist the per-run, per-stream raw covariate snapshot. `db` is a better-sqlite3 handle. */
export function persistSiteCovariateSnapshot(
  db: BetterSqlite3.Database,
  runId: number,
  stream: "camera" | "audio",
  raw: RawSiteCovariates[],
): void {
  const stmt = db.prepare(
    `INSERT INTO occupancy_site_covariates
       (run_id, stream, site_id, site_name, latitude, longitude, habitat, elevation, forest_cover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of raw) {
    stmt.run(
      runId,
      stream,
      r.siteId,
      r.siteName,
      r.latitude,
      r.longitude,
      r.habitat,
      r.elevation,
      r.forestCover,
    );
  }
}
