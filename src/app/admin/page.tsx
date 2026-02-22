import { requireAdmin } from "@/lib/auth";
import { getUsers, getProjects, getCameraTrapProjects, getUserCameraTrapProjectAccess } from "./actions";
import { AdminClient } from "./admin-client";

export default async function AdminPage() {
  await requireAdmin();

  const [allUsers, allProjects, ctProjects, ctAccess] = await Promise.all([
    getUsers(),
    getProjects(),
    getCameraTrapProjects(),
    getUserCameraTrapProjectAccess(),
  ]);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Administración</h1>
        <p className="text-muted-foreground">
          Gestión de usuarios, permisos y acceso a módulos del portal.
        </p>
      </div>

      <AdminClient
        users={allUsers}
        projects={allProjects}
        ctProjects={ctProjects}
        ctAccess={ctAccess}
      />
    </div>
  );
}
