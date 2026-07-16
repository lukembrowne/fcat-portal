import { requirePermission } from "@/lib/auth";
import { fetchSiteDetail } from "../actions";
import { fetchSiteAudio } from "../habitat-actions";
import { SiteDetailShell } from "./site-detail-shell";
import { db } from "@/db";
import { deployments, cameraTrapProjects } from "@/db/schema";
import { and, eq, isNull, or } from "drizzle-orm";

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

  const [result, siteDepIds] = await Promise.all([
    fetchSiteDetail(siteId),
    fetchSiteAudioDeploymentIds(siteId),
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

  const audioResult = await fetchSiteAudio(siteDepIds);
  const audio = audioResult.success ? audioResult.data : null;

  return (
    <SiteDetailShell
      data={result.data}
      audio={audio}
      siteId={siteId}
      canShare={canShare}
    />
  );
}

/**
 * Look up the AUDIO deployment IDs that belong to this site (sole consumer:
 * fetchSiteAudio). Filters on `excluded_audio` — NOT `excluded_camera` — so the
 * audio drill-down is independent of the camera exclusion: a deployment whose
 * camera was excluded still contributes its audio, and one whose audio recorder
 * was excluded (e.g. CCN-010) is dropped from the audio sections. Reuses the
 * site-name/site-id fallback chain so audio queries resolve the same site set.
 */
async function fetchSiteAudioDeploymentIds(siteId: string): Promise<number[]> {
  const [proj] = await db
    .select({ id: cameraTrapProjects.id })
    .from(cameraTrapProjects)
    .where(eq(cameraTrapProjects.name, "BioChoco"));
  if (!proj) return [];
  const rows = await db
    .select({
      id: deployments.id,
      name: deployments.name,
      siteName: deployments.siteName,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.cameraTrapProjectId, proj.id),
        or(eq(deployments.excludedAudio, false), isNull(deployments.excludedAudio)),
      ),
    );
  return rows
    .filter((r) => {
      if (r.siteName === siteId) return true;
      const extracted = r.name.match(/^(.+?)_V\d+$/i)?.[1];
      return extracted === siteId;
    })
    .map((r) => r.id);
}

