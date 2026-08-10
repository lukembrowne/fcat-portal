/**
 * Cached lookup of applied per-species BirdNET thresholds.
 *
 * At most a few hundred rows (one per species with an applied fit), so the map
 * is loaded whole and interpolated into a generated CASE rather than queried
 * per row. See `applySpeciesConfidenceFilter` for why the correlated-subquery
 * alternative is off the table.
 */

import "server-only";

import { cache } from "react";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { birdnetSpeciesThresholds } from "@/db/schema";
import { log } from "@/lib/log";

export type SpeciesThresholdMap = ReadonlyMap<string, number>;

/** The applied row behind one species' threshold, for surfaces that must say
 *  where the number came from — a fit and a recorded "no hace falta filtro"
 *  decision are both active rows and must never read as the same thing. */
export interface ActiveThreshold {
  species: string;
  threshold: number;
  /** 'fit' = estimated by the logistic model; 'no_filter' = a human decision. */
  source: string;
  appliedAt: Date | null;
}

const EMPTY: SpeciesThresholdMap = new Map();
const EMPTY_ROWS: ReadonlyMap<string, ActiveThreshold> = new Map();

/**
 * species -> the applied threshold row.
 *
 * Wrapped in React `cache` so concurrent server-side callers in one request
 * share a single query — the audio pages issue several aggregations that all
 * need it, the same reason `loadSiteHabitatMap` is cached.
 *
 * Returns an empty map on failure rather than throwing: a thresholds-table
 * problem should degrade the portal to the global default, not take down every
 * audio page.
 */
export const loadActiveSpeciesThresholdRows = cache(
  async (): Promise<ReadonlyMap<string, ActiveThreshold>> => {
    try {
      const rows = await db
        .select({
          species: birdnetSpeciesThresholds.species,
          threshold: birdnetSpeciesThresholds.thresholdConf95,
          source: birdnetSpeciesThresholds.source,
          appliedAt: birdnetSpeciesThresholds.appliedAt,
        })
        .from(birdnetSpeciesThresholds)
        .where(eq(birdnetSpeciesThresholds.isActive, true));

      const map = new Map<string, ActiveThreshold>();
      for (const row of rows) {
        // An active row always has a threshold (applyThreshold refuses an
        // unusable fit), but guard anyway — a NULL here would generate
        // `>= NULL`, which is never true and would silently hide the species.
        if (row.threshold != null && Number.isFinite(row.threshold)) {
          map.set(row.species, {
            species: row.species,
            threshold: row.threshold,
            source: row.source,
            appliedAt: row.appliedAt ?? null,
          });
        }
      }
      return map;
    } catch (err) {
      log.warn(
        { err },
        "[birdnet-threshold] could not load applied thresholds; using global default"
      );
      return EMPTY_ROWS;
    }
  }
);

/**
 * species -> applied confidence threshold, the shape every read-time filter
 * wants. Derived from the cached row loader, so a request that needs both pays
 * for one query.
 */
export const loadActiveSpeciesThresholds = cache(
  async (): Promise<SpeciesThresholdMap> => {
    const rows = await loadActiveSpeciesThresholdRows();
    if (rows.size === 0) return EMPTY;
    return new Map([...rows.values()].map((r) => [r.species, r.threshold]));
  }
);
