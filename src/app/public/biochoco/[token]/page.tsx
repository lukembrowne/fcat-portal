import type { Metadata } from "next";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { images } from "@/db/schema";
import {
  fetchSiteDetailByToken,
  recordSiteView,
} from "@/app/biochoco/resultados/actions";
import { PublicSiteShell } from "./public-site-shell";

interface PageProps {
  params: Promise<{ token: string }>;
}

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL || "https://portal.fcat-ecuador.org";

/**
 * The site's starred image ids, scoped to the token's deployment snapshot. The
 * TOKEN is the auth here (this page is unauthenticated) — we deliberately do NOT
 * call the editor-permission `fetchSiteStarredPhotoOptions`. Mirrors the same
 * deployment-snapshot gate the token page already trusts. Seeds the mobile
 * tap-to-fullscreen gallery of all starred photos (U11).
 */
async function fetchStarredImageIds(depIds: number[]): Promise<number[]> {
  if (depIds.length === 0) return [];
  const rows = await db
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.starred, true), inArray(images.deploymentId, depIds)))
    .orderBy(images.starredAt, images.id);
  return rows.map((r) => r.id);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  const data = await fetchSiteDetailByToken(token);

  if (!data) {
    return {
      title: "Enlace no válido — Portal FCAT",
      robots: { index: false, follow: false },
    };
  }

  const siteName = data.site?.siteName ?? data.siteId;
  const speciesCount = data.species.length;
  const description =
    speciesCount > 0
      ? `${speciesCount} especies detectadas en ${data.deploymentCount} ${
          data.deploymentCount === 1 ? "visita" : "visitas"
        }`
      : `Resultados del monitoreo de biodiversidad en ${siteName}`;

  const ogImages = data.heroImageId
    ? [
        {
          url: `${PUBLIC_BASE_URL}/api/public/site-images/${token}/${data.heroImageId}?size=large`,
          alt: siteName,
        },
      ]
    : [];

  return {
    title: `${siteName} — Portal FCAT`,
    description,
    // Token-gated page: keep it out of search engines (a leaked link should
    // never surface a landowner's name/photos in results). OG scrapers
    // (WhatsApp/Facebook) ignore this, so rich link previews still work.
    robots: { index: false, follow: false },
    openGraph: {
      title: siteName,
      description,
      siteName: "Portal FCAT",
      type: "website",
      images: ogImages,
    },
  };
}

export default async function PublicBiochocoSitePage({ params }: PageProps) {
  const { token } = await params;
  const data = await fetchSiteDetailByToken(token);

  if (!data) {
    return (
      <div className="text-center py-20 space-y-3">
        <h1 className="text-2xl font-bold">Este enlace ya no es válido</h1>
        <p className="text-muted-foreground">
          El enlace que has seguido ha sido revocado o no existe.
        </p>
        <p className="text-sm text-muted-foreground">
          Si necesitas acceso a estos resultados, contacta a FCAT.
        </p>
      </div>
    );
  }

  // Fire-and-forget view tracking. The action swallows its own errors, so a
  // bare await here can never break the render (KTD-3: page body only, never
  // in generateMetadata or the cached fetch).
  await recordSiteView(token);

  const hasIntroVideo = Boolean(process.env.LANDOWNER_INTRO_VIDEO_DRIVE_FILE_ID);
  const starredImageIds = await fetchStarredImageIds(data.deploymentIds);
  const publicUrl = `${PUBLIC_BASE_URL}/public/biochoco/${token}`;

  return (
    <PublicSiteShell
      data={data}
      token={token}
      hasIntroVideo={hasIntroVideo}
      starredImageIds={starredImageIds}
      publicUrl={publicUrl}
    />
  );
}
