/**
 * Sidebar Navigation — Async Server Component
 *
 * Computes permission-filtered navigation tree and passes it to
 * the client-side SidebarShell for rendering. Spanish labels, English routes.
 *
 * Icons are passed as string names (not component references) because
 * functions cannot cross the Server→Client component boundary.
 */

import { hasProjectAccess } from "@/lib/auth";
import type { AuthUser } from "@/lib/types";
import { SidebarShell } from "@/components/sidebar-shell";

export type IconName = "home" | "tree-pine" | "leaf" | "camera" | "shield" | "dollar-sign" | "bar-chart-3" | "cloud-sun";

export interface NavItem {
  label: string;
  href?: string;
  icon?: IconName;
  children?: NavItem[];
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

interface SidebarNavProps {
  user: AuthUser;
}

export function SidebarNav({ user }: SidebarNavProps) {
  const isBiochocoEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "biochoco" &&
        (p.role === "editor" || p.role === "admin")
    );

  const hasBiochoco = hasProjectAccess(user, "biochoco");
  const hasCameraTrap = hasProjectAccess(user, "camera-trap");
  const hasGiz = hasProjectAccess(user, "giz");
  const hasClimate = hasProjectAccess(user, "climate");
  const isClimateEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "climate" &&
        (p.role === "editor" || p.role === "admin")
    );

  // Build BioChocó children
  const biochocoChildren: NavItem[] = [];

  if (hasBiochoco) {
    biochocoChildren.push({ label: "Resumen", href: "/biochoco/overview" });
    biochocoChildren.push({ label: "Recursos", href: "/biochoco/recursos" });
    biochocoChildren.push({ label: "Hábitat", href: "/biochoco/habitat" });
    biochocoChildren.push({ label: "Datos", href: "/biochoco/data" });
    if (isBiochocoEditor) {
      biochocoChildren.push({
        label: "Herramientas",
        href: "/biochoco/tools",
      });
    }
  }

  // Build projects section
  const projectItems: NavItem[] = [{ label: "Inicio", href: "/", icon: "home" }];

  if (hasGiz) {
    projectItems.push({
      label: "GIZ",
      icon: "tree-pine",
      children: [
        { label: "Siembra de Árboles", href: "/giz/tree-planting" },
        { label: "Monitoreo de Cacao", href: "/giz/cacao-monitoring" },
      ],
    });
  }

  if (hasBiochoco) {
    projectItems.push({
      label: "BioChocó",
      icon: "leaf",
      children: biochocoChildren,
    });
  }

  if (hasClimate) {
    const climateChildren: NavItem[] = [
      { label: "Panel", href: "/climate/dashboard" },
    ];
    if (isClimateEditor) {
      climateChildren.push({ label: "Cargar Datos", href: "/climate/upload" });
    }
    climateChildren.push({ label: "Acerca de", href: "/climate/about" });
    projectItems.push({
      label: "Datos Climáticos",
      icon: "cloud-sun",
      children: climateChildren,
    });
  }

  const sections: NavSection[] = [
    { title: "Proyectos", items: projectItems },
  ];

  // Análisis section — reusable analysis modules
  const analysisItems: NavItem[] = [];

  if (hasCameraTrap) {
    analysisItems.push({
      label: "Cámaras Trampa",
      icon: "camera",
      children: [
        { label: "Dashboard", href: "/camera-trap" },
        { label: "Resultados", href: "/camera-trap/results" },
      ],
    });
  }

  if (analysisItems.length > 0) {
    sections.push({ title: "Análisis", items: analysisItems });
  }

  // Admin section
  if (user.globalRole === "super_admin") {
    sections.push({
      title: "Administración",
      items: [
        {
          label: "Finanzas",
          icon: "dollar-sign",
          children: [
            { label: "Flujo de Caja", href: "/finance/cashflow" },
            { label: "Ingresos", href: "/finance/revenue" },
            { label: "Gastos", href: "/finance/expenses" },
            { label: "Sueldos", href: "/finance/sueldos" },
            { label: "Presupuesto", href: "/finance/budget" },
            { label: "Comparación Anual", href: "/finance/annual" },
            { label: "Cargar Datos", href: "/finance/data" },
          ],
        },
        { label: "Panel de Admin", href: "/admin", icon: "shield" },
      ],
    });
  }

  return <SidebarShell sections={sections} user={user} />;
}
