import { requirePermission } from "@/lib/auth";

export default async function ProcessLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePermission("camera-trap", "viewer");
  return <>{children}</>;
}
