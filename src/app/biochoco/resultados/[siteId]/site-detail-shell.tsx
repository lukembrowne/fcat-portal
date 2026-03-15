"use client";

import Link from "next/link";
import type { SiteDetail } from "../types";
import { getHabitatName } from "../../overview/types";
import { SiteLocationMap } from "./site-location-map";
import { SpeciesCards } from "./species-cards";
import { TemperatureOverlay } from "./temperature-overlay";
import { HabitatSection } from "./habitat-section";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import { MapPin, Calendar, Camera, Volume2 } from "lucide-react";

interface SiteDetailShellProps {
  data: SiteDetail;
  siteId: string;
}

export function SiteDetailShell({ data, siteId }: SiteDetailShellProps) {
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
          <h1 className="text-2xl font-bold tracking-tight">{site.siteName}</h1>
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

      <Separator />

      {/* Fauna */}
      <section>
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
          <Camera className="h-5 w-5" />
          Fauna
        </h2>
        <SpeciesCards
          species={data.species}
          totalDetections={data.species.reduce(
            (sum, s) => sum + s.detectionCount,
            0
          )}
        />
      </section>

      <Separator />

      {/* Temperatura */}
      <TemperatureOverlay
        temperature={data.temperature}
        temperatureStats={data.temperatureStats}
      />

      <Separator />

      {/* Hábitat */}
      <HabitatSection
        habitat={data.habitat}
        totalCount={data.habitatAssessmentCount}
      />

      <Separator />

      {/* Audio placeholder */}
      <section>
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
          <Volume2 className="h-5 w-5" />
          Audio
        </h2>
        <Card className="border-dashed">
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground font-medium">Próximamente</p>
            <p className="text-sm text-muted-foreground mt-1">
              Los datos de monitoreo acústico se integrarán en una futura
              actualización.
            </p>
          </CardContent>
        </Card>
      </section>
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
