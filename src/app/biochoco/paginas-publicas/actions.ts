"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { siteShareTokens } from "@/db/schema";
import { isNull } from "drizzle-orm";
import type { ActionResult } from "@/lib/types";
import { log } from "@/lib/log";
import { fetchResultadosData, getSiteShareLink } from "../resultados/actions";
import { deriveSitePageStatus } from "@/lib/landowner/page-status";
import { sortSitePublicPageRows, type SitePublicPageRow } from "./sort";

// ---------------------------------------------------------------------------
// Finca public-pages status list (U3)
// ---------------------------------------------------------------------------
//
// One row per biochoco site with its DERIVED public-page status (KTD-2). The
// site list reuses fetchResultadosData (single source of truth for the ODK-
// derived site set); each site is left-joined to its single active share token
// (revoked_at IS NULL, guaranteed unique by the partial index in schema.ts).
//
// The row type + SORTABLE_COLUMNS map live in ./sort (a "use server" file may
// only export async functions, so the runtime sort map can't live here).

export async function fetchSitePublicPagesData(sort?: {
  sortBy: string;
  sortDir: "asc" | "desc";
}): Promise<ActionResult<SitePublicPageRow[]>> {
  try {
    await requirePermission("biochoco", "editor");

    // Reuse the canonical ODK-derived site list (siteId, siteName, habitatType,
    // deploymentCount) instead of re-deriving the deployment→site mapping.
    const [resultados, tokenRows] = await Promise.all([
      fetchResultadosData(),
      db
        .select({
          biochocoSiteId: siteShareTokens.biochocoSiteId,
          createdAt: siteShareTokens.createdAt,
          pageConfig: siteShareTokens.pageConfig,
          lastViewedAt: siteShareTokens.lastViewedAt,
          viewCount: siteShareTokens.viewCount,
        })
        .from(siteShareTokens)
        .where(isNull(siteShareTokens.revokedAt)),
    ]);

    if (!resultados.success) {
      return { success: false, error: resultados.error };
    }

    // At most one active token per site (unique partial index), so a plain Map
    // is a faithful "left join".
    const activeBySite = new Map(tokenRows.map((t) => [t.biochocoSiteId, t]));

    const rows: SitePublicPageRow[] = resultados.data.sites.map((site) => {
      const token = activeBySite.get(site.siteId) ?? null;
      const status = deriveSitePageStatus({
        hasActiveToken: token != null,
        lastViewedAt: token?.lastViewedAt ?? null,
        pageConfig: token?.pageConfig ?? null,
      });
      return {
        siteId: site.siteId,
        siteName: site.siteName,
        habitat: site.habitatType,
        deploymentCount: site.deploymentCount,
        readiness: site.readiness,
        status,
        lastEditedAt: token?.createdAt ?? null,
        lastViewedAt: token?.lastViewedAt ?? null,
        viewCount: token?.viewCount ?? 0,
        hasActiveToken: token != null,
      };
    });

    // Validate sort against the allowlist + apply a stable siteId tiebreaker.
    return { success: true, data: sortSitePublicPageRows(rows, sort) };
  } catch (err) {
    log.error({ err }, "Failed to fetch site public pages data");
    return {
      success: false,
      error:
        err instanceof Error ? err.message : "Error al cargar páginas públicas",
    };
  }
}

// ---------------------------------------------------------------------------
// Token-scoped share URL fetch (KTD-4)
// ---------------------------------------------------------------------------
//
// The table never carries a raw share URL in its row data — it is fetched on
// demand, per row, only when the user opens that row's action menu. Keeping the
// URL off the row avoids the "copied the wrong link" failure mode entirely.
export async function getSiteShareUrl(
  siteId: string
): Promise<ActionResult<string>> {
  try {
    await requirePermission("biochoco", "editor");
    const link = await getSiteShareLink(siteId);
    if (!link) {
      return { success: false, error: "No hay un enlace activo para esta finca" };
    }
    return { success: true, data: link.url };
  } catch (err) {
    log.error({ err }, "Failed to fetch site share url");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al obtener el enlace",
    };
  }
}
