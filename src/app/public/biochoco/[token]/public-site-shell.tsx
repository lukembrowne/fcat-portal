"use client";

import type { PublicSiteDetail } from "@/app/biochoco/resultados/actions";
import { getHabitatName } from "@/app/biochoco/overview/types";
import { SiteResultsContent } from "@/app/biochoco/resultados/[siteId]/site-results-content";
import { CompactStatBar } from "@/components/compact-stat-bar";
import {
  buildSiteStats,
  formatSiteDateRange,
} from "@/app/biochoco/resultados/[siteId]/site-header-stats";
import { Camera, Calendar, Thermometer, TreePine, MapPin } from "lucide-react";

interface PublicSiteShellProps {
  data: PublicSiteDetail;
  token: string;
}

function slugifySpecies(name: string): string {
  return encodeURIComponent(name.toLowerCase().replace(/\s+/g, "-"));
}

export function PublicSiteShell({ data, token }: PublicSiteShellProps) {
  const { site } = data;
  const siteName = site?.siteName ?? data.siteId;
  const habitatLabel = site ? getHabitatName(site.habitatType) : "";

  const stats = buildSiteStats(data, {
    species: <Camera className="h-4 w-4" />,
    temperature: <Thermometer className="h-4 w-4" />,
    habitat: <TreePine className="h-4 w-4" />,
  });

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
              {formatSiteDateRange(data.dateRange.start, data.dateRange.end)}
            </span>
          )}
        </div>
      </header>

      <CompactStatBar stats={stats} />

      <SiteResultsContent
        data={data}
        resolveImageUrl={resolveImageUrl}
        speciesHref={speciesHref}
        variant="public"
      />
    </div>
  );
}
