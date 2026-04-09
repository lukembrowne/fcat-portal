"use client";

import type { PublicSiteDetail } from "@/app/biochoco/resultados/actions";
import { getHabitatName } from "@/app/biochoco/overview/types";
import { SiteResultsContent } from "@/app/biochoco/resultados/[siteId]/site-results-content";
import { Camera, Calendar, Thermometer, TreePine, MapPin } from "lucide-react";

interface PublicSiteShellProps {
  data: PublicSiteDetail;
  token: string;
}

function slugifySpecies(name: string): string {
  return encodeURIComponent(name.toLowerCase().replace(/\s+/g, "-"));
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return "";
  const fmt = (d: string) => {
    const [y, m, day] = d.slice(0, 10).split("-");
    return `${day}/${m}/${y}`;
  };
  if (!end) return `desde ${fmt(start)}`;
  return `${fmt(start)} — ${fmt(end)}`;
}

export function PublicSiteShell({ data, token }: PublicSiteShellProps) {
  const { site } = data;
  const siteName = site?.siteName ?? data.siteId;
  const habitatLabel = site ? getHabitatName(site.habitatType) : "";

  const totalDetections = data.species.reduce(
    (sum, s) => sum + s.detectionCount,
    0
  );

  const resolveImageUrl = (id: number, size: "thumb" | "large") =>
    `/api/public/site-images/${token}/${id}?size=${size}`;

  const speciesHref = (speciesName: string) =>
    `/public/biochoco/${token}/especies/${slugifySpecies(speciesName)}`;

  return (
    <div className="space-y-6">
      {/* Header — site name + code, no GPS, no breadcrumb, no map */}
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{siteName}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" />
            {data.siteId}
          </span>
          {habitatLabel && <span>{habitatLabel}</span>}
          {data.dateRange.start && (
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {formatDateRange(data.dateRange.start, data.dateRange.end)}
            </span>
          )}
        </div>
      </header>

      {/* Compact stat bar — single row, mobile-scrollable */}
      <div className="flex flex-wrap gap-2 sm:gap-3 text-sm">
        <Stat
          icon={<Camera className="h-4 w-4" />}
          value={data.species.length}
          label={data.species.length === 1 ? "especie" : "especies"}
        />
        <Stat
          value={totalDetections}
          label={totalDetections === 1 ? "detección" : "detecciones"}
        />
        <Stat
          value={data.deploymentCount}
          label={data.deploymentCount === 1 ? "visita" : "visitas"}
        />
        <Stat
          value={data.totalCameraTrapDays}
          label="días de cámara"
        />
        {data.temperatureStats && (
          <Stat
            icon={<Thermometer className="h-4 w-4" />}
            value={`${data.temperatureStats.mean.toFixed(1)}°C`}
            label="temp. promedio"
          />
        )}
        {data.habitat && (
          <Stat
            icon={<TreePine className="h-4 w-4" />}
            value={`${data.habitat.canopyCoverPercent}%`}
            label="dosel"
          />
        )}
      </div>

      <SiteResultsContent
        data={data}
        resolveImageUrl={resolveImageUrl}
        speciesHref={speciesHref}
        variant="public"
      />
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
}: {
  icon?: React.ReactNode;
  value: string | number;
  label: string;
}) {
  return (
    <div className="bg-muted rounded-lg px-3 py-2 flex items-center gap-2">
      {icon && <span className="text-muted-foreground">{icon}</span>}
      <span className="font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
