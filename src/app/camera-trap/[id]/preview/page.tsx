import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { ImageGrid, type ImageGridItem } from "@/components/image-grid";
import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { db } from "@/db";
import { deployments, images, videos, IMAGE_TIMESTAMP_ORDER } from "@/db/schema";
import { eq } from "drizzle-orm";
import { PreviewProcessButton } from "./preview-process-button";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PreviewPage({ params }: PageProps) {
  const user = await requirePermission("camera-trap", "viewer");
  const { id } = await params;
  const deploymentId = parseInt(id, 10);

  if (isNaN(deploymentId)) notFound();

  try {
    await requireDeploymentAccess(user, deploymentId);
  } catch {
    notFound();
  }

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId));

  if (!deployment) notFound();

  const depImages = await db
    .select()
    .from(images)
    .where(eq(images.deploymentId, deploymentId))
    .orderBy(IMAGE_TIMESTAMP_ORDER, images.filename);

  const depVideos = await db
    .select()
    .from(videos)
    .where(eq(videos.deploymentId, deploymentId));

  const videoMap = new Map(depVideos.map((v) => [v.id, v]));

  const gridImages: ImageGridItem[] = depImages.map((img) => {
    const vid = img.videoId ? videoMap.get(img.videoId) : null;
    return {
      id: img.id,
      filename: img.filename,
      path: img.path,
      status: img.status,
      thumbnailPath: img.thumbnailPath,
      videoId: img.videoId ?? null,
      frameIndex: img.frameIndex ?? null,
      videoFilename: vid?.filename ?? null,
      confirmedBlank: img.confirmedBlank ?? false,
      starred: img.starred ?? false,
      detections: [],
    };
  });

  const canEdit =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "camera-trap" &&
        (p.role === "editor" || p.role === "admin")
    );

  const canProcess =
    canEdit &&
    deployment.status !== "processing" &&
    deployment.status !== "unscanned" &&
    depImages.length > 0;

  return (
    <div className="max-w-7xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link href="/camera-trap" className="hover:underline">
          Camaras Trampa
        </Link>
        <span>/</span>
        <Link
          href={`/camera-trap/${deployment.id}`}
          className="hover:underline"
        >
          {deployment.name}
        </Link>
        <span>/</span>
        <span>Vista Previa</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-3xl font-bold mb-1">{deployment.name}</h1>
          <div className="flex items-center gap-4">
            <StatusBadge status={deployment.status} type="deployment" />
            <span className="text-muted-foreground text-sm">
              {depImages.length} imagen{depImages.length !== 1 ? "es" : ""}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {canProcess && (
            <PreviewProcessButton deploymentId={deployment.id} />
          )}
          <Button asChild variant="outline">
            <Link href="/camera-trap">Panel</Link>
          </Button>
        </div>
      </div>

      {/* Image Grid */}
      <ImageGrid
        images={gridImages}
        basePath={`/camera-trap/${deployment.id}/preview`}
      />
    </div>
  );
}
