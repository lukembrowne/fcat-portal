import { getCurrentUser, hasProjectAccess } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Camera, Shield, TreePine, Leaf, DollarSign, CloudSun } from "lucide-react";

interface ModuleLink {
  href: string;
  title: string;
  icon: React.ReactNode;
  show: boolean;
}

export default async function HomePage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/");
  }

  const displayName = user.name || user.email.split("@")[0];

  const modules: ModuleLink[] = [
    {
      href: "/camera-trap",
      title: "Cámaras Trampa",
      icon: <Camera className="h-5 w-5" />,
      show: hasProjectAccess(user, "camera-trap"),
    },
    {
      href: "/giz",
      title: "GIZ",
      icon: <TreePine className="h-5 w-5" />,
      show: hasProjectAccess(user, "giz"),
    },
    {
      href: "/biochoco",
      title: "BioChocó",
      icon: <Leaf className="h-5 w-5" />,
      show: hasProjectAccess(user, "biochoco"),
    },
    {
      href: "/climate",
      title: "Datos Climáticos",
      icon: <CloudSun className="h-5 w-5" />,
      show: hasProjectAccess(user, "climate"),
    },
    {
      href: "/finance",
      title: "Finanzas",
      icon: <DollarSign className="h-5 w-5" />,
      show: user.globalRole === "super_admin",
    },
    {
      href: "/admin",
      title: "Administración",
      icon: <Shield className="h-5 w-5" />,
      show: user.globalRole === "super_admin",
    },
  ];

  const visibleModules = modules.filter((m) => m.show);

  return (
    <div className="relative min-h-[calc(100vh-6rem)] overflow-hidden rounded-2xl border border-border/40 shadow-sm">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/landing-hero.jpg"
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full object-cover"
      />

      {/* legibility gradient over the photo */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/25 to-black/35" />

      {/* content */}
      <div className="relative z-10 flex min-h-[calc(100vh-6rem)] flex-col items-center justify-center gap-10 px-6 py-16 text-center">
        <div className="space-y-3">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-white/70">
            Portal FCAT
          </p>
          <h1 className="text-4xl font-bold text-white drop-shadow-sm sm:text-5xl">
            Bienvenido, {displayName}
          </h1>
          <p className="mx-auto max-w-md text-white/80">
            Fundación para la Conservación de los Andes Tropicales
          </p>
        </div>

        {visibleModules.length === 0 ? (
          <div className="max-w-md rounded-xl bg-white/10 px-6 py-5 text-white/90 backdrop-blur-md">
            <p className="font-medium">Sin acceso a módulos</p>
            <p className="mt-1 text-sm text-white/70">
              Contacta al administrador para solicitar permisos.
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-3">
            {visibleModules.map((mod) => (
              <Link
                key={mod.href}
                href={mod.href}
                className="group flex items-center gap-2.5 rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-sm font-medium text-white backdrop-blur-md transition-all hover:border-white/50 hover:bg-white/20"
              >
                <span className="text-white/85 transition-colors group-hover:text-white">
                  {mod.icon}
                </span>
                {mod.title}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
