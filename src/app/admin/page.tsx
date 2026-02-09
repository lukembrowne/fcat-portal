import { requireAdmin } from "@/lib/auth";
import { getUsers, getProjects } from "./actions";
import { AdminClient } from "./admin-client";

export default async function AdminPage() {
  await requireAdmin();

  const [allUsers, allProjects] = await Promise.all([
    getUsers(),
    getProjects(),
  ]);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Administración</h1>
        <p className="text-muted-foreground">
          Gestión de usuarios, permisos y acceso a módulos del portal.
        </p>
      </div>

      <AdminClient users={allUsers} projects={allProjects} />
    </div>
  );
}
