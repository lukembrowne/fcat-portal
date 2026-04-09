"use client";

import Link from "next/link";
import type { SiteDetail } from "../types";
import { getHabitatName } from "../../overview/types";
import { SiteResultsContent } from "./site-results-content";
import { SiteShareButton } from "./site-share-button";
import { CompactStatBar } from "./compact-stat-bar";
import { buildSiteStats, formatSiteDateRange } from "./site-header-stats";
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

  const stats = buildSiteStats(data, {
    species: <Camera className="h-4 w-4" />,
    temperature: <Thermometer className="h-4 w-4" />,
    habitat: <TreePine className="h-4 w-4" />,
  });

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

      {/* Header */}
      <header>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">
              {site.siteName}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground mt-1">
              <span className="flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {site.siteId}
              </span>
              <span>{getHabitatName(site.habitatType)}</span>
              {data.dateRange.start && (
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  {formatSiteDateRange(data.dateRange.start, data.dateRange.end)}
                </span>
              )}
            </div>
          </div>
          {canShare && (
            <SiteShareButton
              siteId={siteId}
              existingLink={existingShareLink}
            />
          )}
        </div>
      </header>

      <CompactStatBar stats={stats} />

      <SiteResultsContent
        data={data}
        resolveImageUrl={internalImageUrl}
        speciesHref={null}
        variant="internal"
      />
    </div>
  );
}
