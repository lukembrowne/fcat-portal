import { requirePermission } from "@/lib/auth";
import {
  fetchIbuttonStatus,
  fetchTemperatureDistributions,
  fetchProcessedDeployments,
} from "./actions";
import { TemperatureShell } from "./temperature-shell";

export default async function IbuttonPage() {
  const user = await requirePermission("biochoco", "viewer");

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "biochoco" &&
        (p.role === "editor" || p.role === "admin")
    );

  const [statusResult, distributionsResult, deploymentsResult] =
    await Promise.all([
      fetchIbuttonStatus(),
      fetchTemperatureDistributions(),
      fetchProcessedDeployments(),
    ]);

  return (
    <TemperatureShell
      status={statusResult.success ? statusResult.data : null}
      distributionPoints={
        distributionsResult.success ? distributionsResult.data.points : []
      }
      deployments={deploymentsResult.success ? deploymentsResult.data : []}
      isEditor={isEditor}
    />
  );
}
