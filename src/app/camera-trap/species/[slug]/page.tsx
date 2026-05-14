import { notFound } from "next/navigation";
import {
  getCameraTrapSpeciesDetail,
  getCameraTrapSpeciesSitePage,
  type SiteSummary,
} from "@/app/camera-trap/species/actions";
import { SpeciesHeader } from "@/components/species/species-header";
import { SpeciesFilterBar } from "@/components/species/species-filter-bar";
import { SiteList } from "@/components/species/site-list";
import { DeploymentMap } from "@/components/species/deployment-map";
import { ImageGrid } from "@/components/image-grid";
import {
  parsePositiveInt,
  parseProjectId,
  parseStatuses,
} from "@/lib/species-search-params";
import Link from "next/link";
import { speciesSlug } from "@/lib/species-slug";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function buildQuery(
  params: Record<string, string | string[] | undefined>,
  overrides: Record<string, string | null>
): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value[0]) next.set(key, value[0]);
    } else {
      next.set(key, value);
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) next.delete(k);
    else next.set(k, v);
  }
  return next.toString();
}

export default async function CameraTrapSpeciesDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { slug } = await params;
  const search = await searchParams;
  const detail = await getCameraTrapSpeciesDetail(slug, search);
  if (!detail.success) {
    return (
      <div className="max-w-5xl mx-auto p-4">
        <p className="text-destructive">{detail.error}</p>
      </div>
    );
  }
  if (detail.data === null) notFound();

  const { species, totalCount, sites, sitesWithoutLocation, availableProjects } =
    detail.data;
  const totalSites = sites.length + sitesWithoutLocation.length;

  // Whitelist filter params before any subsequent query
  const statuses = parseStatuses(search.status);
  const projectId = parseProjectId(
    search.project,
    availableProjects.map((p) => p.id)
  );
  const siteIdRaw = search.site;
  const siteId = (() => {
    const v = parsePositiveInt(
      Array.isArray(siteIdRaw) ? siteIdRaw[0] : siteIdRaw,
      0
    );
    return v > 0 ? v : null;
  })();
  const page = parsePositiveInt(
    Array.isArray(search.page) ? search.page[0] : search.page,
    1
  );

  // Confirm the chosen site is in the (filtered) result set; if not, render
  // empty-state banner and ignore the URL deeplink.
  const allSites: SiteSummary[] = [...sites, ...sitesWithoutLocation];
  const expandedSite = siteId
    ? allSites.find((s) => s.deploymentId === siteId) ?? null
    : null;
  const expansionInvalid = siteId !== null && expandedSite === null;

  let sitePageData: Awaited<ReturnType<typeof getCameraTrapSpeciesSitePage>> | null = null;
  if (expandedSite) {
    sitePageData = await getCameraTrapSpeciesSitePage(
      slug,
      expandedSite.deploymentId,
      page,
      search
    );
  }

  const baseSlug = speciesSlug(species.scientificName);
  const pathname = `/camera-trap/species/${baseSlug}`;

  const buildToggleHref = (deploymentId: number | null): string => {
    const qs = buildQuery(search, {
      site: deploymentId == null ? null : String(deploymentId),
      page: deploymentId == null ? null : "1",
    });
    const base = qs ? `${pathname}?${qs}` : pathname;
    return deploymentId == null ? base : `${base}#site-${deploymentId}`;
  };

  const buildPageHref = (nextPage: number): string => {
    const qs = buildQuery(search, { page: String(nextPage) });
    return qs ? `${pathname}?${qs}` : pathname;
  };

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <SpeciesHeader
        species={species}
        totalCount={totalCount}
        siteCount={totalSites}
        backHref="/camera-trap/species"
      />

      <SpeciesFilterBar
        mode="camera-trap"
        projects={availableProjects}
        selectedStatuses={statuses}
        selectedProjectId={projectId}
      />

      {sites.length === 0 && sitesWithoutLocation.length === 0 ? (
        <p className="text-muted-foreground text-sm py-8 text-center">
          No hay detecciones que coincidan con los filtros.
        </p>
      ) : (
        <>
          {sites.length > 0 && (
            <DeploymentMap
              markers={sites
                .filter((s) => s.latitude != null && s.longitude != null)
                .map((s) => ({
                  deploymentId: s.deploymentId,
                  deploymentName: s.deploymentName,
                  latitude: s.latitude!,
                  longitude: s.longitude!,
                  detectionCount: s.detectionCount,
                  href: buildToggleHref(s.deploymentId),
                }))}
            />
          )}

          {expansionInvalid && (
            <div className="rounded-md border bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm">
              El sitio seleccionado no tiene detecciones con los filtros
              actuales.{" "}
              <Link
                href={`${pathname}?${buildQuery(search, { site: null, page: null })}`}
                scroll={false}
                className="underline"
              >
                Limpiar selección
              </Link>
            </div>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              Sitios ({sites.length})
            </h2>
            <SiteList
              sites={sites}
              expandedSiteId={
                expandedSite && expandedSite.latitude != null
                  ? expandedSite.deploymentId
                  : null
              }
              buildToggleHref={buildToggleHref}
              expansionContent={
                expandedSite &&
                sitePageData?.success &&
                sitePageData.data.items.length > 0 ? (
                  <div className="space-y-3">
                    <ImageGrid
                      images={sitePageData.data.items}
                      columns={4}
                    />
                    {sitePageData.data.totalPages > 1 && (
                      <Pagination
                        currentPage={sitePageData.data.currentPage}
                        totalPages={sitePageData.data.totalPages}
                        buildHref={buildPageHref}
                      />
                    )}
                  </div>
                ) : expandedSite ? (
                  <p className="text-muted-foreground text-sm py-4 text-center">
                    Sin detecciones para este sitio con los filtros actuales.
                  </p>
                ) : null
              }
            />
          </section>

          {sitesWithoutLocation.length > 0 && (
            <details className="rounded-lg border bg-muted/20 px-3 py-2 group">
              <summary className="cursor-pointer text-sm font-medium">
                Sin ubicación ({sitesWithoutLocation.length})
              </summary>
              <div className="mt-2">
                <SiteList
                  sites={sitesWithoutLocation}
                  expandedSiteId={
                    expandedSite && expandedSite.latitude == null
                      ? expandedSite.deploymentId
                      : null
                  }
                  buildToggleHref={buildToggleHref}
                  expansionContent={
                    expandedSite &&
                    expandedSite.latitude == null &&
                    sitePageData?.success &&
                    sitePageData.data.items.length > 0 ? (
                      <div className="space-y-3">
                        <ImageGrid
                          images={sitePageData.data.items}
                          columns={4}
                        />
                        {sitePageData.data.totalPages > 1 && (
                          <Pagination
                            currentPage={sitePageData.data.currentPage}
                            totalPages={sitePageData.data.totalPages}
                            buildHref={buildPageHref}
                          />
                        )}
                      </div>
                    ) : null
                  }
                />
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Pagination({
  currentPage,
  totalPages,
  buildHref,
}: {
  currentPage: number;
  totalPages: number;
  buildHref: (page: number) => string;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">
        Página {currentPage} de {totalPages}
      </span>
      <div className="flex gap-2">
        {currentPage > 1 && (
          <Link
            href={buildHref(currentPage - 1)}
            scroll={false}
            className="px-3 py-1 rounded border"
          >
            Anterior
          </Link>
        )}
        {currentPage < totalPages && (
          <Link
            href={buildHref(currentPage + 1)}
            scroll={false}
            className="px-3 py-1 rounded border"
          >
            Siguiente
          </Link>
        )}
      </div>
    </div>
  );
}
