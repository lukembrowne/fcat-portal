import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { db } from "@/db";
import { deployments, cameraTrapProjects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { fetchAudioFiles } from "../actions";
import { AudioFilesShell } from "./audio-files-shell";

export default async function AudioDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("grabaciones", "viewer");

  const { id } = await params;
  const deploymentId = parseInt(id, 10);
  if (isNaN(deploymentId)) notFound();

  await requireDeploymentAccess(user, deploymentId);

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "grabaciones" &&
        (p.role === "editor" || p.role === "admin")
    );

  const [deployment] = await db
    .select({
      id: deployments.id,
      name: deployments.name,
      siteName: deployments.siteName,
      dateStart: deployments.dateStart,
      dateEnd: deployments.dateEnd,
      latitude: deployments.latitude,
      longitude: deployments.longitude,
      ctProjectName: cameraTrapProjects.name,
    })
    .from(deployments)
    .leftJoin(
      cameraTrapProjects,
      eq(deployments.cameraTrapProjectId, cameraTrapProjects.id)
    )
    .where(eq(deployments.id, deploymentId));

  if (!deployment) notFound();

  const filesResult = await fetchAudioFiles(deploymentId);

  return (
    <AudioFilesShell
      deployment={deployment}
      files={filesResult.success ? filesResult.data : []}
      isEditor={isEditor}
    />
  );
}
