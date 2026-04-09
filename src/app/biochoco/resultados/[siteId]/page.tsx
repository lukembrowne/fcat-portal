import { requirePermission } from "@/lib/auth";
import { fetchSiteDetail, getSiteShareLink } from "../actions";
import { SiteDetailShell } from "./site-detail-shell";

const ROLE_HIERARCHY = { viewer: 1, editor: 2, admin: 3 } as const;

export default async function SiteDetailPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const user = await requirePermission("biochoco", "viewer");
  const { siteId: rawSiteId } = await params;
  const siteId = decodeURIComponent(rawSiteId);

  // Compute biochoco editor+ status server-side. We never trust the
  // client to render the share button — the parent only passes
  // canShare=true when the role check passes here.
  const biochocoRole = user.permissions.find(
    (p) => p.projectId === "biochoco"
  )?.role;
  const canShare =
    user.globalRole === "super_admin" ||
    (biochocoRole !== undefined &&
      ROLE_HIERARCHY[biochocoRole] >= ROLE_HIERARCHY.editor);

  const [result, existingLink] = await Promise.all([
    fetchSiteDetail(siteId),
    canShare ? getSiteShareLink(siteId) : Promise.resolve(null),
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
    <SiteDetailShell
      data={result.data}
      siteId={siteId}
      canShare={canShare}
      existingShareLink={existingLink}
    />
  );
}
