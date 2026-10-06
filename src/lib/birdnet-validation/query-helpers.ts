import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { species as speciesTable } from "@/db/schema";
import { resolveBirdnetName } from "@/lib/birdnet-taxonomy";
import type { getUserCameraTrapProjects } from "@/lib/camera-trap-auth";

/**
 * Query helpers shared by the validation server actions and the correct-
 * detections export. Here rather than in `actions.ts` because a `"use server"`
 * module may only export async functions, and the scope predicate is not one.
 */

/**
 * The caller's camera-trap project scope as a SQL predicate over the `d`
 * (biochoco_deployments) alias — the same scope `detectedSpeciesCounts` and
 * the sampler apply.
 *
 * Over a LEFT JOIN it also decides recordings with no deployment: `'all'`
 * (`1 = 1`) keeps them, while a project list never matches a NULL
 * `d.ct_project_id`, so a scoped caller does not see them.
 */
export function deploymentScopeSql(
  ctProjects: Awaited<ReturnType<typeof getUserCameraTrapProjects>>
) {
  if (ctProjects === "all") return sql`1 = 1`;
  if (ctProjects.length === 0) return sql`1 = 0`;
  return sql`d.ct_project_id IN (${sql.join(
    ctProjects.map((id) => sql`${id}`),
    sql`, `
  )})`;
}

/**
 * Common names for a scientific name: the species table first (curated), then
 * BirdNET's own label list, which covers a corrected species with no
 * `biochoco_species` row.
 */
export async function speciesNamesFor(
  scientificNames: string[]
): Promise<Map<string, { commonName: string | null; spanishName: string | null }>> {
  const out = new Map<string, { commonName: string | null; spanishName: string | null }>();
  if (scientificNames.length === 0) return out;
  const rows = await db
    .select({
      scientificName: speciesTable.scientificName,
      commonName: speciesTable.commonName,
      spanishName: speciesTable.spanishName,
    })
    .from(speciesTable)
    .where(inArray(speciesTable.scientificName, scientificNames));
  for (const row of rows) {
    out.set(row.scientificName, {
      commonName: row.commonName,
      spanishName: row.spanishName,
    });
  }
  for (const name of scientificNames) {
    if (out.has(name)) continue;
    const birdnet = resolveBirdnetName(name);
    out.set(name, {
      commonName: birdnet?.commonName ?? null,
      spanishName: birdnet?.spanishName ?? null,
    });
  }
  return out;
}
