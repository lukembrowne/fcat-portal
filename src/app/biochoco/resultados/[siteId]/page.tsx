import { requirePermission } from "@/lib/auth";
import { fetchSiteDetail } from "../actions";
import { SiteDetailShell } from "./site-detail-shell";

export default async function SiteDetailPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  await requirePermission("biochoco", "viewer");
  const { siteId } = await params;

  const result = await fetchSiteDetail(decodeURIComponent(siteId));

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
          No se encontró un sitio con ID &ldquo;{siteId}&rdquo;
        </p>
      </div>
    );
  }

  return <SiteDetailShell data={result.data} siteId={siteId} />;
}
