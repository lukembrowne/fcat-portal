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

export type IconName = "home" | "tree-pine" | "leaf" | "camera" | "shield" | "dollar-sign" | "bar-chart-3" | "cloud-sun" | "clipboard-list" | "thermometer" | "audio-lines" | "scroll-text" | "file-text" | "activity" | "list-checks" | "hard-drive";

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

/**
 * Builds the ordered children of the BioChocó "Página pública" group.
 * Pure + exported for unit testing (no DB, no React).
 */
export function buildBiochocoPublicNav({
  isBiochocoEditor,
  isSuperAdmin,
}: {
  isBiochocoEditor: boolean;
  isSuperAdmin: boolean;
}): NavItem[] {
  const publicChildren: NavItem[] = [];
  if (isBiochocoEditor) {
    publicChildren.push({
      label: "Páginas de fincas",
      href: "/biochoco/paginas-publicas",
    });
    publicChildren.push({
      label: "Fichas de especies",
      href: "/biochoco/fichas-especies",
    });
  }
  if (isSuperAdmin) {
    publicChildren.push({
      label: "Resumen divulgativo",
      href: "/admin/biochoco-overview",
    });
  }
  return publicChildren;
}

/**
 * Ordered children of the "Grabaciones" analysis group.
 *
 * Pure + exported for unit testing (no DB, no React), same as
 * `buildBiochocoPublicNav` above.
 */
export function buildAudioNav({
  isGrabacionesEditor,
}: {
  isGrabacionesEditor: boolean;
}): NavItem[] {
  const children: NavItem[] = [
    { label: "Instalaciones", href: "/audio" },
    { label: "Explorar por especie", href: "/audio/species" },
  ];
  // Editor-gated: viewers cannot run campaigns, draw samples, or review, so the
  // page would be read-only scaffolding for them.
  if (isGrabacionesEditor) {
    children.push({
      label: "Validación de umbrales",
      href: "/audio/validacion",
    });
  }
  return children;
}

export function SidebarNav({ user }: SidebarNavProps) {
  const isBiochocoAdmin =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "biochoco" && p.role === "admin"
    );
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
    biochocoChildren.push({ label: "Temperatura", href: "/biochoco/ibutton" });
    biochocoChildren.push({ label: "Resultados", href: "/biochoco/resultados" });
    biochocoChildren.push({ label: "Recursos", href: "/biochoco/recursos" });
    if (isBiochocoAdmin) {
      biochocoChildren.push({
        label: "Herramientas",
        href: "/biochoco/tools",
      });
    }
    const publicChildren = buildBiochocoPublicNav({
      isBiochocoEditor,
      isSuperAdmin: user.globalRole === "super_admin",
    });
    if (publicChildren.length > 0) {
      biochocoChildren.push({
        label: "Página pública",
        children: publicChildren,
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

  const hasMonitoreo = hasProjectAccess(user, "monitoreo");
  if (hasMonitoreo) {
    projectItems.push({
      label: "Monitoreo Programático",
      icon: "clipboard-list",
      children: [
        { label: "Actividades Sociales", href: "/monitoreo/social-activities" },
      ],
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

  const hasResearcherApps = hasProjectAccess(user, "researcher-applications");
  const hasGrants = hasProjectAccess(user, "grants");

  const sections: NavSection[] = [
    { title: "Proyectos", items: projectItems },
  ];

  // Análisis section — reusable analysis modules
  const analysisItems: NavItem[] = [];

  const isGrabacionesEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "grabaciones" &&
        (p.role === "editor" || p.role === "admin")
    );

  const isCameraTrapEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "camera-trap" &&
        (p.role === "editor" || p.role === "admin")
    );

  const isCameraTrapAdmin =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "camera-trap" && p.role === "admin",
    );

  if (hasCameraTrap) {
    const cameraTrapChildren: NavItem[] = [
      { label: "Instalaciones", href: "/camera-trap" },
      { label: "Destacadas", href: "/camera-trap/favorites" },
      { label: "Explorar por especie", href: "/camera-trap/species" },
    ];
    if (isCameraTrapEditor) {
      cameraTrapChildren.push({ label: "Administrar especies", href: "/camera-trap/species/manage" });
      cameraTrapChildren.push({ label: "Resultados de detección", href: "/camera-trap/results" });
    }
    if (isCameraTrapAdmin) {
      cameraTrapChildren.push({ label: "Exportes", href: "/camera-trap/training-exports" });
      cameraTrapChildren.push({ label: "Modelos", href: "/camera-trap/models" });
    }
    analysisItems.push({
      label: "Cámaras Trampa",
      icon: "camera",
      children: cameraTrapChildren,
    });
  }

  const hasGrabaciones = hasProjectAccess(user, "grabaciones");
  if (hasGrabaciones) {
    analysisItems.push({
      label: "Grabaciones",
      icon: "audio-lines",
      children: buildAudioNav({ isGrabacionesEditor }),
    });
  }

  if (hasCameraTrap) {
    analysisItems.push({
      label: "Ocupación",
      href: "/ocupacion",
      icon: "leaf",
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

  if (hasResearcherApps) {
    adminItems.push({
      label: "Aplicaciones de Investigadores",
      href: "/research-applications",
      icon: "file-text",
    });
  }

  if (hasGrants) {
    adminItems.push({
      label: "Grant Tracking",
      href: "/grants",
      icon: "dollar-sign",
    });
  }

  if (user.globalRole === "super_admin") {
    adminItems.push({ label: "Panel de Admin", href: "/admin", icon: "shield" });
    adminItems.push({ label: "Trabajos del sistema", href: "/admin/jobs", icon: "list-checks" });
    adminItems.push({ label: "Actividad del sistema", href: "/admin/activity", icon: "activity" });
    adminItems.push({ label: "Shared Drives", href: "/admin/shared-drives", icon: "hard-drive" });
    adminItems.push({ label: "Registros del sistema", href: "/admin/logs", icon: "scroll-text" });
  }

  if (adminItems.length > 0) {
    sections.push({ title: "Administración", items: adminItems });
  }

  return <SidebarShell sections={sections} user={user} />;
}
