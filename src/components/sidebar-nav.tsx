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
  const isBiochocoAdmin =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "biochoco" && p.role === "admin"
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
  const hasFinance = hasProjectAccess(user, "finance");
  const isFinanceEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "finance" &&
        (p.role === "editor" || p.role === "admin")
    );

  // Build BioChocó children
  const biochocoChildren: NavItem[] = [];

  if (hasBiochoco) {
    biochocoChildren.push({ label: "Cronograma", href: "/biochoco/overview" });
    biochocoChildren.push({ label: "Datos", href: "/biochoco/data" });
    biochocoChildren.push({ label: "Hábitat", href: "/biochoco/habitat" });
    biochocoChildren.push({ label: "Recursos", href: "/biochoco/recursos" });
    if (isBiochocoAdmin) {
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

  const isCameraTrapEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "camera-trap" &&
        (p.role === "editor" || p.role === "admin")
    );

  if (hasCameraTrap) {
    const cameraTrapChildren: NavItem[] = [
      { label: "Instalaciones", href: "/camera-trap" },
      { label: "Resultados", href: "/camera-trap/results" },
      { label: "Destacadas", href: "/camera-trap/favorites" },
    ];
    if (isCameraTrapEditor) {
      cameraTrapChildren.push({ label: "Especies", href: "/camera-trap/species" });
    }
    analysisItems.push({
      label: "Cámaras Trampa",
      icon: "camera",
      children: cameraTrapChildren,
    });
  }

  if (analysisItems.length > 0) {
    sections.push({ title: "Análisis", items: analysisItems });
  }

  // Admin section
  const adminItems: NavItem[] = [];

  if (hasFinance) {
    const financeChildren: NavItem[] = [
      { label: "Flujo de Caja", href: "/finance/cashflow" },
      { label: "Ingresos", href: "/finance/revenue" },
      { label: "Gastos", href: "/finance/expenses" },
      { label: "Sueldos", href: "/finance/sueldos" },
      { label: "Presupuesto", href: "/finance/budget" },
      { label: "Comparación Anual", href: "/finance/annual" },
    ];
    if (isFinanceEditor) {
      financeChildren.push({ label: "Cargar Datos", href: "/finance/data" });
    }
    adminItems.push({
      label: "Finanzas",
      icon: "dollar-sign",
      children: financeChildren,
    });
  }

  if (user.globalRole === "super_admin") {
    adminItems.push({ label: "Panel de Admin", href: "/admin", icon: "shield" });
  }

  if (adminItems.length > 0) {
    sections.push({ title: "Administración", items: adminItems });
  }

  return <SidebarShell sections={sections} user={user} />;
}
