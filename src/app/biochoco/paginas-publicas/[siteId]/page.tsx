import { requirePermission } from "@/lib/auth";
import { fetchSiteDetail, getSiteShareLink } from "../../resultados/actions";
import { BuilderShell } from "./builder-shell";

export default async function SitePublicPageBuilderPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  await requirePermission("biochoco", "editor");
  const { siteId: rawSiteId } = await params;
  const siteId = decodeURIComponent(rawSiteId);

  const [result, shareLink] = await Promise.all([
    fetchSiteDetail(siteId),
    getSiteShareLink(siteId),
  ]);

  if (!result.success) {
    return (
      <div className="flex items-center justify-center h-[400px]">
        <p className="text-destructive">{result.error}</p>
      </div>
    );
  }

  if (!result.data.site) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px] gap-2">
        <p className="text-lg font-medium">Sitio no encontrado</p>
        <p className="text-muted-foreground">
          No se encontró un sitio con ID &ldquo;{rawSiteId}&rdquo;
        </p>
      </div>
    );
  }

  return (
    <BuilderShell
      siteId={siteId}
      siteName={result.data.site.siteName}
      shareLink={shareLink}
    />
  );
}
