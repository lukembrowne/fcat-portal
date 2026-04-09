"use client";

import Link from "next/link";
import type { SiteDetail } from "../types";
import { getHabitatName } from "../../overview/types";
import { SiteLocationMap } from "./site-location-map";
import { SiteResultsContent } from "./site-results-content";
import { SiteShareButton } from "./site-share-button";
import { Card, CardContent } from "@/components/ui/card";
import { MapPin, Calendar, Camera, Thermometer, TreePine } from "lucide-react";

interface SiteShareLink {
  token: string;
  url: string;
  createdAt: Date;
  createdBy: string;
  label: string | null;
}

interface SiteDetailShellProps {
  data: SiteDetail;
  siteId: string;
  /** True only for biochoco editors+ — gates the share button render. */
  canShare: boolean;
  existingShareLink: SiteShareLink | null;
}

const internalImageUrl = (id: number, size: "thumb" | "large") =>
  `/api/ct-images/${id}?size=${size}`;

export function SiteDetailShell({
  data,
  siteId,
  canShare,
  existingShareLink,
}: SiteDetailShellProps) {
  const { site } = data;
  if (!site) return null;

  return (
    <div className="space-y-6 min-w-0">
      {/* Breadcrumb */}
      <nav className="text-sm text-muted-foreground">
        <Link href="/biochoco/resultados" className="hover:text-foreground">
          Resultados
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground font-medium">{site.siteName}</span>
      </nav>

      {/* Header + Map */}
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-2xl font-bold tracking-tight">{site.siteName}</h1>
            {canShare && (
              <SiteShareButton
                siteId={siteId}
                existingLink={existingShareLink}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground mt-1">
            <span className="flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" />
              {site.siteId}
            </span>
            <span>{getHabitatName(site.habitatType)}</span>
            {site.lat && site.lng && (
              <span>
                {site.lat.toFixed(5)}, {site.lng.toFixed(5)}
              </span>
            )}
          </div>

          {/* Summary stats */}
          <div className="flex flex-wrap gap-4 mt-4">
            <div className="bg-muted rounded-lg px-4 py-2">
              <p className="text-2xl font-bold">{data.deploymentCount}</p>
              <p className="text-xs text-muted-foreground">
                {data.deploymentCount === 1 ? "visita" : "visitas"}
              </p>
            </div>
            <div className="bg-muted rounded-lg px-4 py-2">
              <p className="text-2xl font-bold">{data.totalCameraTrapDays}</p>
              <p className="text-xs text-muted-foreground">días de cámara trampa</p>
            </div>
            {data.dateRange.start && (
              <div className="bg-muted rounded-lg px-4 py-2">
                <p className="text-sm font-medium flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  {formatDateRange(data.dateRange.start, data.dateRange.end)}
                </p>
                <p className="text-xs text-muted-foreground">rango de monitoreo</p>
              </div>
            )}
          </div>
        </div>

        {/* Small location map */}
        {site.lat && site.lng && (
          <div className="w-full lg:w-[300px] shrink-0">
            <SiteLocationMap lat={site.lat} lng={site.lng} />
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Fauna */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm font-medium mb-2">
              <Camera className="h-4 w-4 text-muted-foreground" />
              Fauna
            </div>
            {data.species.length > 0 ? (
              <>
                <p className="text-2xl font-bold">{data.species.length} <span className="text-sm font-normal text-muted-foreground">{data.species.length === 1 ? "especie" : "especies"}</span></p>
                <p className="text-sm text-muted-foreground">
                  {data.species.reduce((sum, s) => sum + s.detectionCount, 0)} detecciones
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Sin datos</p>
            )}
          </CardContent>
        </Card>

        {/* Temperatura */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm font-medium mb-2">
              <Thermometer className="h-4 w-4 text-muted-foreground" />
              Temperatura
            </div>
            {data.temperatureStats ? (
              <>
                <p className="text-2xl font-bold">{data.temperatureStats.mean.toFixed(1)}°C <span className="text-sm font-normal text-muted-foreground">promedio</span></p>
                <p className="text-sm text-muted-foreground">
                  {data.temperatureStats.min.toFixed(1)} — {data.temperatureStats.max.toFixed(1)}°C · {data.temperature.length} {data.temperature.length === 1 ? "despliegue" : "despliegues"}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Sin datos</p>
            )}
          </CardContent>
        </Card>

        {/* Hábitat */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm font-medium mb-2">
              <TreePine className="h-4 w-4 text-muted-foreground" />
              Hábitat
            </div>
            {data.habitat ? (
              <>
                <p className="text-2xl font-bold">{data.habitat.canopyCoverPercent}% <span className="text-sm font-normal text-muted-foreground">dosel</span></p>
                <p className="text-sm text-muted-foreground">
                  Sotobosque: {data.habitat.understoryDensity}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Sin datos</p>
            )}
          </CardContent>
        </Card>
      </div>

      <SiteResultsContent
        data={data}
        resolveImageUrl={internalImageUrl}
        speciesHref={null}
        variant="internal"
      />
    </div>
  );
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return "—";
  const fmt = (d: string) => {
    const [y, m, day] = d.slice(0, 10).split("-");
    return `${day}/${m}/${y}`;
  };
  if (!end) return `desde ${fmt(start)}`;
  return `${fmt(start)} — ${fmt(end)}`;
}
