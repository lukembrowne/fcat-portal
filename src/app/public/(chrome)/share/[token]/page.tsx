import type { Metadata } from "next";
import { cache } from "react";
import { db } from "@/db";
import {
  shareTokens,
  deployments,
  processingJobs,
  images,
  detections,
  identifications,
  species as speciesTable,
} from "@/db/schema";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { isValidShareToken } from "@/lib/public-tokens";
import { PublicImageGrid } from "./public-image-grid";

interface PageProps {
  params: Promise<{ token: string }>;
}

const getShareData = cache(async function getShareData(token: string) {
  if (!isValidShareToken(token)) {
    return null;
  }

  const [shareToken] = await db
    .select()
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.token, token),
        sql`${shareTokens.revokedAt} IS NULL`
      )
    );

  if (!shareToken) return null;

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, shareToken.deploymentId));

  if (!deployment) return null;

  // Get latest completed processing job
  const [latestJob] = await db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deployment.id),
        eq(processingJobs.status, "completed")
      )
    )
    .orderBy(desc(processingJobs.completedAt))
    .limit(1);

  // Get images — from latest job if available, otherwise all deployment images
  const jobImages = latestJob
    ? await db
        .select()
        .from(images)
        .where(eq(images.jobId, latestJob.id))
        .orderBy(images.filename)
    : await db
        .select()
        .from(images)
        .where(eq(images.deploymentId, deployment.id))
        .orderBy(images.filename);

  // Get species detections if we have a job
  let speciesSummary: { name: string; displayName: string; count: number }[] = [];

  if (latestJob && jobImages.length > 0) {
    const imageIds = jobImages.map((img) => img.id);
    const jobDetections = await db
      .select()
      .from(detections)
      .where(inArray(detections.imageId, imageIds));

    if (jobDetections.length > 0) {
      const detectionIds = jobDetections.map((d) => d.id);
      const jobIdentifications = await db
        .select()
        .from(identifications)
        .where(
          and(
            inArray(identifications.detectionId, detectionIds),
            sql`${identifications.verificationStatus} != 'rejected'`
          )
        );

      // Count species
      const speciesCount: Record<string, number> = {};
      for (const ident of jobIdentifications) {
        const name = ident.correctedSpecies || ident.species;
        speciesCount[name] = (speciesCount[name] || 0) + 1;
      }

      // Look up Spanish names
      const speciesNames = Object.keys(speciesCount);
      const speciesLookup =
        speciesNames.length > 0
          ? await db
              .select()
              .from(speciesTable)
              .where(inArray(speciesTable.scientificName, speciesNames))
          : [];

      const nameMap = new Map(
        speciesLookup.map((s) => [
          s.scientificName,
          s.spanishName || s.commonName,
        ])
      );

      speciesSummary = Object.entries(speciesCount)
        .sort(([, a], [, b]) => b - a)
        .map(([name, count]) => ({
          name,
          displayName: nameMap.get(name) || name,
          count,
        }));
    }
  }

  return {
    deployment: {
      name: deployment.name,
      dateStart: deployment.dateStart,
      dateEnd: deployment.dateEnd,
      totalImages: deployment.totalImages ?? 0,
    },
    images: jobImages.map((img) => ({
      id: img.id,
      filename: img.filename,
    })),
    speciesSummary,
    token,
  };
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  const data = await getShareData(token);

  if (!data) {
    return { title: "Enlace no válido — Portal FCAT" };
  }

  const speciesCount = data.speciesSummary.length;
  const description = speciesCount > 0
    ? `${data.images.length} imágenes · ${speciesCount} especies detectadas`
    : `${data.images.length} imágenes de cámara trampa`;

  return {
    title: `${data.deployment.name} — Portal FCAT`,
    description,
    openGraph: {
      title: data.deployment.name,
      description,
      siteName: "Portal FCAT",
      type: "website",
    },
  };
}

export default async function PublicSharePage({ params }: PageProps) {
  const { token } = await params;
  const data = await getShareData(token);

  if (!data) {
    return (
      <div className="text-center py-20">
        <h1 className="text-2xl font-bold mb-3">
          Este enlace ya no es válido
        </h1>
        <p className="text-muted-foreground">
          El enlace que has seguido ha sido revocado o no existe.
        </p>
      </div>
    );
  }

  const { deployment, speciesSummary } = data;

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">{deployment.name}</h1>
        {(deployment.dateStart || deployment.dateEnd) && (
          <p className="text-muted-foreground">
            {deployment.dateStart}
            {deployment.dateEnd && ` — ${deployment.dateEnd}`}
          </p>
        )}
      </div>

      {/* Species Summary */}
      {speciesSummary.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">
            Especies detectadas ({speciesSummary.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {speciesSummary.map((s) => (
              <span
                key={s.name}
                className="inline-flex items-center gap-1.5 px-3 py-1 bg-muted rounded-full text-sm"
              >
                <span>{s.displayName}</span>
                <span className="text-muted-foreground">({s.count})</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Image Grid */}
      {data.images.length > 0 ? (
        <PublicImageGrid
          images={data.images}
          token={data.token}
          totalCount={data.images.length}
        />
      ) : (
        <p className="text-muted-foreground text-center py-10">
          No hay imágenes disponibles para esta instalación.
        </p>
      )}
    </div>
  );
}
