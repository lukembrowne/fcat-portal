import { requirePermission } from "@/lib/auth";
import { fetchIbuttonStatus, fetchHabitatSummary, fetchProcessedDeployments } from "./actions";
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

  const [statusResult, habitatResult, deploymentsResult] = await Promise.all([
    fetchIbuttonStatus(),
    fetchHabitatSummary(),
    fetchProcessedDeployments(),
  ]);

  return (
    <TemperatureShell
      status={statusResult.success ? statusResult.data : null}
      habitatSummary={habitatResult.success ? habitatResult.data : []}
      deployments={deploymentsResult.success ? deploymentsResult.data : []}
      isEditor={isEditor}
    />
  );
}
