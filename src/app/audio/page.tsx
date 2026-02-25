import { requirePermission } from "@/lib/auth";
import {
  fetchAudioDeployments,
  fetchDistinctAudioProjects,
} from "./actions";
import { AudioDeploymentsShell } from "./audio-deployments-shell";

export default async function AudioPage() {
  const user = await requirePermission("camera-trap", "viewer");

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "camera-trap" &&
        (p.role === "editor" || p.role === "admin")
    );

  const [deploymentsResult, distinctProjects] = await Promise.all([
    fetchAudioDeployments(),
    fetchDistinctAudioProjects(),
  ]);

  return (
    <AudioDeploymentsShell
      deployments={deploymentsResult.success ? deploymentsResult.data : []}
      distinctProjects={distinctProjects}
      isEditor={isEditor}
    />
  );
}
