import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Camera, Shield, TreePine, Leaf } from "lucide-react";
import type { AuthUser } from "@/lib/types";

function hasProjectAccess(user: AuthUser, projectId: string): boolean {
  if (user.globalRole === "super_admin") return true;
  return user.permissions.some((p) => p.projectId === projectId);
}

interface ModuleCard {
  href: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  show: boolean;
}

export default async function HomePage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/");
  }

  const displayName = user.name || user.email.split("@")[0];

  const modules: ModuleCard[] = [
    {
      href: "/camera-trap",
      title: "Cámaras Trampa",
      description:
        "Procesamiento de imágenes con detección y clasificación de especies mediante inteligencia artificial",
      icon: <Camera className="h-8 w-8 text-muted-foreground" />,
      show: hasProjectAccess(user, "camera-trap"),
    },
    {
      href: "/giz/tree-planting",
      title: "GIZ",
      description:
        "Monitoreo de siembra de árboles y cacao para el proyecto GIZ",
      icon: <TreePine className="h-8 w-8 text-muted-foreground" />,
      show: hasProjectAccess(user, "giz"),
    },
    {
      href: "/biochoco/overview",
      title: "BioChocó",
      description:
        "Cronograma de sensores acústicos y monitoreo de biodiversidad",
      icon: <Leaf className="h-8 w-8 text-muted-foreground" />,
      show: hasProjectAccess(user, "biochoco"),
    },
    {
      href: "/admin",
      title: "Administración",
      description: "Gestión de usuarios, permisos y acceso a módulos del portal",
      icon: <Shield className="h-8 w-8 text-muted-foreground" />,
      show: user.globalRole === "super_admin",
    },
  ];

  const visibleModules = modules.filter((m) => m.show);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">
          Bienvenido, {displayName}
        </h1>
        <p className="text-muted-foreground mt-1">
          Selecciona un módulo para comenzar
        </p>
      </div>

      {visibleModules.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Sin acceso</CardTitle>
            <CardDescription>
              No tienes acceso a ningún módulo. Contacta al administrador para
              solicitar permisos.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleModules.map((mod) => (
            <Link key={mod.href} href={mod.href}>
              <Card className="h-full transition-colors hover:bg-accent/50 cursor-pointer">
                <CardHeader>
                  <div className="mb-2">{mod.icon}</div>
                  <CardTitle className="text-lg">{mod.title}</CardTitle>
                  <CardDescription>{mod.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
