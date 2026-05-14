import { requirePermission } from "@/lib/auth";
import { getCameraTrapSpeciesIndex } from "./actions";
import { SpeciesIndexTable } from "@/components/species/species-index-table";
import Link from "next/link";

export default async function CameraTrapSpeciesIndexPage() {
  const user = await requirePermission("camera-trap", "viewer");
  const result = await getCameraTrapSpeciesIndex();
  if (!result.success) {
    return (
      <div className="max-w-5xl mx-auto p-4">
        <p className="text-destructive">{result.error}</p>
      </div>
    );
  }

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "camera-trap" &&
        (p.role === "editor" || p.role === "admin")
    );

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Explorar por especie</h1>
          <p className="text-sm text-muted-foreground">
            Detecciones de cámaras trampa, agregadas por especie en todos los
            proyectos a los que tienes acceso.
          </p>
        </div>
        {isEditor && (
          <Link
            href="/camera-trap/species/manage"
            className="text-sm underline text-muted-foreground hover:text-foreground"
          >
            Administrar especies →
          </Link>
        )}
      </header>

      <SpeciesIndexTable
        rows={result.data}
        basePath="/camera-trap/species"
      />
    </div>
  );
}
