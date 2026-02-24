import { requirePermission } from "@/lib/auth";
import { fetchDeploymentReadings } from "../actions";
import { DeploymentDetailShell } from "./deployment-detail-shell";
import { notFound } from "next/navigation";

export default async function IbuttonDeploymentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("biochoco", "viewer");
  const { id } = await params;

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "biochoco" &&
        (p.role === "editor" || p.role === "admin")
    );

  const deploymentId = parseInt(id, 10);
  if (isNaN(deploymentId)) notFound();

  const result = await fetchDeploymentReadings(deploymentId);
  if (!result.success) notFound();

  return <DeploymentDetailShell data={result.data} isEditor={isEditor} />;
}
