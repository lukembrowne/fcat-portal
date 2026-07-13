/**
 * Habitat-resolution audit for the occupancy site pool.
 *
 * For every deployment that enters occupancy modeling (verified + not excluded),
 * reports whether a categorical habitat resolves from the ODK site entities and,
 * when it doesn't, WHY — so we can tell a name-matching miss (fixable in code)
 * from a genuinely-missing ODK `habitat_type` (a field-data gap). This runs
 * inside the app (ODK + DB + src available) rather than as a standalone script,
 * which a prod standalone image can't run (see the prod-scripts gotcha).
 *
 *   GET /api/ocupacion/habitat-audit   (camera-trap admin) → audit JSON
 */
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { deployments, cameraTrapProjects } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { log } from "@/lib/log";
import { fetchEntities } from "@/lib/odk-client";
import { BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES } from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import {
  loadSiteHabitatMap,
  resolveHabitatForDeployment,
  extractSiteIdFromDeploymentName,
  UNKNOWN_HABITAT_KEY,
} from "@/lib/habitat-lookup";

export const dynamic = "force-dynamic";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const isAdmin =
    user.globalRole === "super_admin" ||
    user.permissions.some((p) => p.projectId === "camera-trap" && p.role === "admin");
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    // Occupancy site pool: same filter as fetchOccupancyInputs — verified + not
    // excluded AND scoped to the BioChoco ct project (other projects' deployments
    // have no BioChoco ODK site entity and are excluded from the analysis).
    const [biochoco] = await db
      .select({ id: cameraTrapProjects.id })
      .from(cameraTrapProjects)
      .where(eq(cameraTrapProjects.name, "BioChoco"));
    const pool = biochoco
      ? await db
          .select({ id: deployments.id, name: deployments.name, siteName: deployments.siteName })
          .from(deployments)
          .where(
            and(
              eq(deployments.excluded, false),
              inArray(deployments.status, ["verified", "verified_empty"]),
              eq(deployments.cameraTrapProjectId, biochoco.id),
            ),
          )
      : [];

    // Exact-match map used by the pipeline (only entities WITH a habitat_type).
    const map = await loadSiteHabitatMap();

    // Raw ODK entities — including those with an EMPTY habitat_type — so we can
    // distinguish "no matching entity" from "entity exists but habitat_type vacío".
    let entities: OdkSiteEntity[] = [];
    try {
      entities = await fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES, {
        tags: ["biochoco-sites"],
      });
    } catch (err) {
      log.warn({ err }, "[habitat-audit] ODK entities unavailable");
    }

    // Normalized (trim + lowercase) indexes to classify near-misses.
    const normHabitat = new Map<string, string>(); // key → habitat_type (non-empty)
    const normEntityKeys = new Set<string>(); // any entity key (even empty habitat)
    for (const e of entities) {
      for (const key of [e.site_id, e.site_name, e.label]) {
        const nk = norm(key);
        if (!nk) continue;
        normEntityKeys.add(nk);
        if (e.habitat_type) normHabitat.set(nk, e.habitat_type);
      }
    }

    const rows = pool.map((d) => {
      const resolved = resolveHabitatForDeployment(
        { siteName: d.siteName, deploymentName: d.name },
        map,
      );
      if (resolved !== UNKNOWN_HABITAT_KEY) {
        return { id: d.id, name: d.name, siteName: d.siteName, habitat: resolved, status: "resuelto", reason: null };
      }
      const candidates = [d.siteName, extractSiteIdFromDeploymentName(d.name), d.name]
        .map(norm)
        .filter(Boolean);
      const normMatch = candidates.find((c) => normHabitat.has(c));
      if (normMatch) {
        return {
          id: d.id, name: d.name, siteName: d.siteName, habitat: null, status: "desconocido",
          reason: `coincidencia solo tras normalizar mayúsculas/espacios (ODK: ${normHabitat.get(normMatch)}) — el emparejamiento exacto falla`,
        };
      }
      if (candidates.some((c) => normEntityKeys.has(c))) {
        return {
          id: d.id, name: d.name, siteName: d.siteName, habitat: null, status: "desconocido",
          reason: "existe una entidad ODK que coincide pero su habitat_type está vacío",
        };
      }
      return {
        id: d.id, name: d.name, siteName: d.siteName, habitat: null, status: "desconocido",
        reason: "no hay una entidad ODK que coincida con este sitio",
      };
    });

    // Unknown first, then by name — the actionable rows float to the top.
    rows.sort((a, b) => Number(a.status === "resuelto") - Number(b.status === "resuelto") || a.name.localeCompare(b.name));

    const unknown = rows.filter((r) => r.status !== "resuelto");
    const byReason: Record<string, number> = {};
    for (const r of unknown) if (r.reason) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      totalDeployments: rows.length,
      resolved: rows.length - unknown.length,
      unknown: unknown.length,
      byReason,
      odkEntities: entities.length,
      rows,
    });
  } catch (error) {
    log.error({ err: error }, "[habitat-audit] failed");
    return NextResponse.json({ error: "No se pudo generar la auditoría de hábitat." }, { status: 500 });
  }
}
