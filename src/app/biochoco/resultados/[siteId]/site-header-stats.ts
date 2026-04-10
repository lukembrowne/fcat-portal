import type { ReactNode } from "react";
import type { SiteDetail } from "../types";
import type { CompactStat } from "@/components/compact-stat-bar";

/**
 * Builds the compact stat row shown at the top of both the internal and
 * public site result pages. Keeping this in one place means a new stat
 * (or a tweak to the singular/plural rules) lands in both views at once.
 *
 * Icons are injected by the caller because this file is a plain .ts
 * module — importing lucide-react here would force every consumer to
 * accept a JSX dependency, and the shells already import the icons for
 * their header anyway.
 */
export function buildSiteStats(
  data: SiteDetail,
  icons: {
    species: ReactNode;
    temperature: ReactNode;
    habitat: ReactNode;
  },
): CompactStat[] {
  const totalDetections = data.species.reduce(
    (sum, s) => sum + s.detectionCount,
    0,
  );

  const stats: CompactStat[] = [
    {
      icon: icons.species,
      value: data.species.length,
      label: data.species.length === 1 ? "especie" : "especies",
    },
    {
      value: totalDetections,
      label: totalDetections === 1 ? "detección" : "detecciones",
    },
    {
      value: data.deploymentCount,
      label: data.deploymentCount === 1 ? "visita" : "visitas",
    },
    {
      value: data.totalCameraTrapDays,
      label: "días de cámara",
    },
  ];

  if (data.temperatureStats) {
    stats.push({
      icon: icons.temperature,
      value: `${data.temperatureStats.mean.toFixed(1)}°C`,
      label: "temp. promedio",
    });
  }

  if (data.habitat) {
    stats.push({
      icon: icons.habitat,
      value: `${data.habitat.canopyCoverPercent}%`,
      label: "dosel",
    });
  }

  return stats;
}

/**
 * Formats a site's deployment date range in `dd/mm/yyyy` form. Matches
 * the Spanish-language conventions used throughout the biochoco UI —
 * don't swap in toLocaleDateString without checking both views.
 */
export function formatSiteDateRange(
  start: string | null,
  end: string | null,
): string {
  if (!start) return "—";
  const fmt = (d: string) => {
    const [y, m, day] = d.slice(0, 10).split("-");
    return `${day}/${m}/${y}`;
  };
  if (!end) return `desde ${fmt(start)}`;
  return `${fmt(start)} — ${fmt(end)}`;
}
