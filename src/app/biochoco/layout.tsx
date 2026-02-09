import { getCurrentUser } from "@/lib/auth";
import { SubNav } from "@/components/sub-nav";

export default async function BiochocoLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  const isEditor =
    user?.globalRole === "super_admin" ||
    (user?.permissions.some(
      (p) => p.projectId === "biochoco" && (p.role === "editor" || p.role === "admin"),
    ) ?? false);

  const tabs = [
    { href: "/biochoco/overview", label: "Resumen" },
    ...(isEditor ? [{ href: "/biochoco/tools", label: "Herramientas" }] : []),
  ];

  return (
    <div>
      <SubNav items={tabs} />
      {children}
    </div>
  );
}
