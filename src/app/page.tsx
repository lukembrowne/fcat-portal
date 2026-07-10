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

/**
 * Full-bleed, layered "cloud forest" scene rendered as inline SVG — no external
 * asset, scales crisply, and reads well under white text in either theme.
 */
function CloudForestScene() {
  return (
    <svg
      aria-hidden
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 1440 720"
      preserveAspectRatio="xMidYMax slice"
    >
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0d3b33" />
          <stop offset="45%" stopColor="#1f5c48" />
          <stop offset="78%" stopColor="#4a8a63" />
          <stop offset="100%" stopColor="#cfe3a9" />
        </linearGradient>
        <radialGradient id="sun" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fdf1c9" stopOpacity="0.95" />
          <stop offset="45%" stopColor="#f3d79a" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#f3d79a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="mist" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="100%" stopColor="#e9f2d6" stopOpacity="0.35" />
        </linearGradient>
      </defs>

      {/* sky + low sun */}
      <rect width="1440" height="720" fill="url(#sky)" />
      <circle cx="1010" cy="470" r="240" fill="url(#sun)" />

      {/* receding ridgelines: lighter + hazier the farther back */}
      <path
        d="M0 470 C 240 405, 430 445, 660 415 S 1120 380, 1440 430 L1440 720 L0 720 Z"
        fill="#6ea583"
        opacity="0.55"
      />
      <path
        d="M0 520 C 260 470, 470 505, 720 475 S 1160 455, 1440 505 L1440 720 L0 720 Z"
        fill="#4c8a67"
        opacity="0.75"
      />
      <path
        d="M0 585 C 220 545, 520 585, 760 555 S 1200 545, 1440 585 L1440 720 L0 720 Z"
        fill="#2f6b4c"
      />

      {/* drifting mist bands between the ridges */}
      <rect x="0" y="470" width="1440" height="120" fill="url(#mist)" />

      {/* foreground canopy silhouette */}
      <path
        d="M0 640 C 120 610, 200 655, 300 632 C 380 612, 440 648, 540 636 C 640 624, 700 656, 820 640 C 940 624, 1010 658, 1140 640 C 1260 624, 1330 654, 1440 636 L1440 720 L0 720 Z"
        fill="#173d2b"
      />
    </svg>
  );
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
      <CloudForestScene />

      {/* legibility gradient over the scene */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-black/10 to-black/25" />

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
