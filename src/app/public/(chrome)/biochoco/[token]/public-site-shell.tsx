"use client";

import type { PublicSiteDetail } from "@/app/biochoco/resultados/actions";
import { getHabitatName } from "@/app/biochoco/overview/types";
import { SiteResultsContent } from "@/app/biochoco/resultados/[siteId]/site-results-content";
import { formatSiteDateRange } from "@/app/biochoco/resultados/[siteId]/site-header-stats";
import { ContactForm } from "./contact-form";
import { Calendar, MapPin, TreePine } from "lucide-react";

interface PublicSiteShellProps {
  data: PublicSiteDetail;
  token: string;
  /** Whether a fixed intro/thank-you video is configured (server-resolved). */
  hasIntroVideo?: boolean;
}

function slugifySpecies(name: string): string {
  return encodeURIComponent(name.toLowerCase().replace(/\s+/g, "-"));
}

export function PublicSiteShell({
  data,
  token,
  hasIntroVideo = false,
}: PublicSiteShellProps) {
  const { site } = data;
  const siteName = site?.siteName ?? data.siteId;
  const habitatLabel = site ? getHabitatName(site.habitatType) : "";

  const resolveImageUrl = (id: number, size: "thumb" | "large") =>
    `/api/public/site-images/${token}/${id}?size=${size}`;

  const speciesHref = (speciesName: string) =>
    `/public/biochoco/${token}/especies/${slugifySpecies(speciesName)}`;

  // Hero: the curated hero image, else the best available species photo.
  const heroImageId =
    data.heroImageId ??
    data.species.find((s) => s.photoImageId != null)?.photoImageId ??
    null;

  const speciesCount = data.species.length;
  const days = data.totalCameraTrapDays;

  return (
    <div className="space-y-6">
      {heroImageId != null ? (
        <div className="relative -mx-4 sm:mx-0 sm:rounded-2xl overflow-hidden aspect-[4/3] sm:aspect-[16/9] bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={resolveImageUrl(heroImageId, "large")}
            alt={`Fauna registrada en ${siteName}`}
            className="object-cover w-full h-full"
            loading="eager"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6 text-white">
            <p className="text-sm font-medium opacity-90">
              Esto vive en su finca
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight drop-shadow">
              {siteName}
            </h1>
          </div>
        </div>
      ) : (
        <header className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">
            Esto vive en su finca
          </p>
          <h1 className="text-2xl font-bold tracking-tight">{siteName}</h1>
        </header>
      )}

      {hasIntroVideo && (
        <video
          controls
          preload="none"
          playsInline
          className="w-full rounded-2xl bg-black aspect-video"
        >
          <source src="/api/public/intro-video" type="video/mp4" />
          Su navegador no puede reproducir este video.
        </video>
      )}

      {/* Human-scale summary — warm, plain Spanish, no science-y stat bar */}
      <div className="space-y-2">
        <p className="text-lg leading-relaxed">
          Registramos{" "}
          <strong className="font-semibold">
            {speciesCount}{" "}
            {speciesCount === 1
              ? "especie de animal"
              : "especies de animales"}
          </strong>{" "}
          en su finca
          {days > 0 && (
            <>
              {" "}
              a lo largo de {days} {days === 1 ? "día" : "días"} de monitoreo
            </>
          )}
          .
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" />
            {data.siteId}
          </span>
          {habitatLabel && (
            <span className="flex items-center gap-1">
              <TreePine className="h-3.5 w-3.5" />
              {habitatLabel}
            </span>
          )}
          {data.dateRange.start && (
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {formatSiteDateRange(data.dateRange.start, data.dateRange.end)}
            </span>
          )}
        </div>
      </div>

      <SiteResultsContent
        data={data}
        audio={null}
        resolveImageUrl={resolveImageUrl}
        speciesHref={speciesHref}
        variant="public"
        shareSiteLabel={siteName}
      />

      <ContactForm token={token} />
    </div>
  );
}
