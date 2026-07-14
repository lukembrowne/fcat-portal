import type { Metadata } from "next";
import { fetchSiteDetailByToken } from "@/app/biochoco/resultados/actions";
import { PublicSiteShell } from "./public-site-shell";

interface PageProps {
  params: Promise<{ token: string }>;
}

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL || "https://portal.fcat-ecuador.org";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  const data = await fetchSiteDetailByToken(token);

  if (!data) {
    return { title: "Enlace no válido — Portal FCAT" };
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

  return <PublicSiteShell data={data} token={token} />;
}
