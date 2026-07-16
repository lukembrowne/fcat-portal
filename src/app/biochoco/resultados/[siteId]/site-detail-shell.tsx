"use client";

import Link from "next/link";
import type { SiteDetail, SiteAudioData } from "../types";
import { getHabitatName } from "../../overview/types";
import { SiteResultsContent } from "./site-results-content";
import { CompactStatBar } from "@/components/compact-stat-bar";
import { buildSiteStats, formatSiteDateRange } from "./site-header-stats";
import {
  MapPin,
  Calendar,
  Camera,
  Thermometer,
  TreePine,
  Share2,
} from "lucide-react";

interface SiteDetailShellProps {
  data: SiteDetail;
  /** Audio panels (acoustic indices + BirdNET species). Null on share-public view. */
  audio: SiteAudioData | null;
  siteId: string;
  /** True only for biochoco editors+ — gates the public-page jump link. */
  canShare: boolean;
}

const internalImageUrl = (id: number, size: "thumb" | "large") =>
  `/api/ct-images/${id}?size=${size}`;

export function SiteDetailShell({
  data,
  audio,
  siteId,
  canShare,
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
            <Link
              href={`/biochoco/paginas-publicas/${encodeURIComponent(siteId)}`}
              className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <Share2 className="h-4 w-4" />
              Editar página pública
              <span aria-hidden>→</span>
            </Link>
          )}
        </div>
      </header>

      <CompactStatBar stats={stats} />

      <SiteResultsContent
        data={data}
        audio={audio}
        resolveImageUrl={internalImageUrl}
        speciesHref={null}
        variant="internal"
      />
    </div>
  );
}
