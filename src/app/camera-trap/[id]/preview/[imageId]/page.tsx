import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { getImageWithDetections, getDeploymentImageIds } from "@/app/camera-trap/actions";
import { db } from "@/db";
import { videos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { PreviewImageViewer } from "./preview-image-viewer";

interface PageProps {
  params: Promise<{ id: string; imageId: string }>;
}

export default async function PreviewImagePage({ params }: PageProps) {
  await requirePermission("camera-trap", "viewer");
  const { id, imageId: imageIdStr } = await params;
  const deploymentId = parseInt(id, 10);
  const imageId = parseInt(imageIdStr, 10);

  if (isNaN(deploymentId) || isNaN(imageId)) notFound();

  const data = await getImageWithDetections(imageId);
  if (!data) notFound();

  const { image, deploymentName } = data;

  // Format timestamp for display
  const rawTimestamp = image.exifTimestamp
    ? new Date(image.exifTimestamp)
    : image.fileModified
      ? new Date(image.fileModified)
      : null;
  const timestamp =
    rawTimestamp && !isNaN(rawTimestamp.getTime())
      ? rawTimestamp.toLocaleDateString("es-EC", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }) +
        ", " +
        rawTimestamp.toLocaleTimeString("es-EC", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  // Verify image belongs to this deployment
  if (image.deploymentId !== deploymentId) notFound();

  const imageIds = await getDeploymentImageIds(deploymentId);
  const currentIndex = imageIds.indexOf(imageId);
  const prevImageId = currentIndex > 0 ? imageIds[currentIndex - 1] : null;
  const nextImageId =
    currentIndex < imageIds.length - 1 ? imageIds[currentIndex + 1] : null;

  const fullImageUrl = `/api/ct-images/${image.id}?size=full`;

  return (
    <div className="max-w-7xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
        <Link href="/camera-trap" className="hover:underline">
          Camaras Trampa
        </Link>
        <span>/</span>
        <Link
          href={`/camera-trap/${deploymentId}/preview`}
          className="hover:underline"
        >
          {deploymentName ?? `Instalacion ${deploymentId}`}
        </Link>
        <span>/</span>
        <span>{image.filename}</span>
      </div>

      <PreviewImageViewer
        src={fullImageUrl}
        alt={image.filename}
        deploymentId={deploymentId}
        deploymentName={deploymentName}
        filename={image.filename}
        timestamp={timestamp}
        prevImageId={prevImageId}
        nextImageId={nextImageId}
        currentIndex={currentIndex}
        totalImages={imageIds.length}
      >
        {image.videoId && (
          <VideoFrameLabel
            videoId={image.videoId}
            frameIndex={image.frameIndex}
          />
        )}
      </PreviewImageViewer>
    </div>
  );
}

async function VideoFrameLabel({
  videoId,
  frameIndex,
}: {
  videoId: number;
  frameIndex: number | null;
}) {
  const [video] = await db
    .select({ filename: videos.filename })
    .from(videos)
    .where(eq(videos.id, videoId));

  if (!video) return null;

  return (
    <p className="text-sm text-muted-foreground mt-0.5">
      Cuadro {(frameIndex ?? 0) + 1} de{" "}
      <span className="font-medium">{video.filename}</span>
    </p>
  );
}
