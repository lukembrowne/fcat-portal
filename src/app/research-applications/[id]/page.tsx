import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePermission, getCurrentUser } from "@/lib/auth";
import { getApplicationDetail } from "./actions";
import { DetailClient } from "./detail-client";
import { Button } from "@/components/ui/button";

export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("researcher-applications", "viewer");
  const user = await getCurrentUser();
  if (!user) notFound();
  const { id } = await params;

  const appId = parseInt(id, 10);
  if (isNaN(appId)) notFound();

  const app = await getApplicationDetail(appId);
  if (!app) notFound();

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "researcher-applications" &&
        (p.role === "editor" || p.role === "admin")
    );

  return (
    <div className="space-y-4">
      <Link href="/research-applications">
        <Button variant="ghost" size="sm">
          ← Volver a la lista
        </Button>
      </Link>

      <DetailClient app={app} isEditor={isEditor} />
    </div>
  );
}
