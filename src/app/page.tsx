import { getCurrentUser, hasProjectAccess } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Camera, Shield, TreePine, Leaf, DollarSign } from "lucide-react";

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
      icon: <Camera className="h-6 w-6" />,
      show: hasProjectAccess(user, "camera-trap"),
    },
    {
      href: "/giz",
      title: "GIZ",
      description:
        "Monitoreo de siembra de árboles y cacao para el proyecto GIZ",
      icon: <TreePine className="h-6 w-6" />,
      show: hasProjectAccess(user, "giz"),
    },
    {
      href: "/biochoco",
      title: "BioChocó",
      description:
        "Cronograma de sensores acústicos y monitoreo de biodiversidad",
      icon: <Leaf className="h-6 w-6" />,
      show: hasProjectAccess(user, "biochoco"),
    },
    {
      href: "/finance",
      title: "Finanzas",
      description:
        "Dashboard financiero, presupuesto, sueldos y flujo de caja",
      icon: <DollarSign className="h-6 w-6" />,
      show: user.globalRole === "super_admin",
    },
    {
      href: "/admin",
      title: "Administración",
      description: "Gestión de usuarios, permisos y acceso a módulos del portal",
      icon: <Shield className="h-6 w-6" />,
      show: user.globalRole === "super_admin",
    },
  ];

  const visibleModules = modules.filter((m) => m.show);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
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
              <Card className="h-full group transition-all duration-200 hover:shadow-md hover:border-primary/30 cursor-pointer border-border/60">
                <CardHeader>
                  <div className="mb-3 inline-flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 text-primary group-hover:bg-primary/15 transition-colors">
                    {mod.icon}
                  </div>
                  <CardTitle className="text-lg text-foreground">{mod.title}</CardTitle>
                  <CardDescription className="text-muted-foreground">{mod.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
