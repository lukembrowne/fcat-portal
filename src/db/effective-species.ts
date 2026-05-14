/**
 * Effective-species predicates for camera-trap and audio identifications.
 *
 * A detection's "effective species" is what the system currently treats it as,
 * computed from its latest identification row:
 *
 *   verification_status = 'rejected'   → not a detection of any species (skip)
 *   verification_status = 'corrected'  → effective = corrected_species
 *   otherwise                          → effective = species
 *
 * Using a CASE expression in WHERE / GROUP BY defeats SQLite's ability to use
 * indexes on (species) or (corrected_species). The matcher below splits the two
 * paths into an OR of two sargable predicates so each branch can hit a partial
 * index. Aggregation across both effective values is done as two index-eligible
 * SELECTs unioned in JS — see callers.
 *
 * Lives next to the schema deliberately: when the verification_status enum
 * changes, this helper must change in lockstep.
 */

import { sql, type SQL } from "drizzle-orm";
import { identifications, audioIdentifications } from "./schema";

type IdentificationTable = typeof identifications | typeof audioIdentifications;

/**
 * Drizzle SQL fragment: this identification row contributes to the given
 * effective species name. Excludes rejected rows. Pass the Drizzle table
 * object (not a string literal) so renames are caught by TypeScript.
 *
 *   .where(and(effectiveSpeciesMatches(identifications, name), ...))
 */
export function effectiveSpeciesMatches(
  table: IdentificationTable,
  scientificName: string
): SQL {
  return sql`(
    (${table.verificationStatus} IN ('unverified', 'verified')
      AND ${table.species} = ${scientificName})
    OR
    (${table.verificationStatus} = 'corrected'
      AND ${table.correctedSpecies} = ${scientificName})
  )`;
}

/**
 * Predicates that pick rows where the effective species comes from the active
 * (non-corrected, non-rejected) branch. Combined with a `species = ?` filter,
 * this lets the planner hit a partial index on `species`.
 */
export function activeIdentification(table: IdentificationTable): SQL {
  return sql`${table.verificationStatus} IN ('unverified', 'verified')`;
}

/**
 * Predicates that pick rows where the effective species comes from a human
 * correction. Combined with a `corrected_species = ?` filter, this lets the
 * planner hit a partial index on `corrected_species`.
 */
export function correctedIdentification(table: IdentificationTable): SQL {
  return sql`${table.verificationStatus} = 'corrected'`;
}
