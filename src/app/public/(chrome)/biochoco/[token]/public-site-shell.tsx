"use client";

import type {
  PublicSiteDetail,
  ResolvedContentBlock,
} from "@/app/biochoco/resultados/actions";
import { getHabitatName } from "@/app/biochoco/overview/types";
import { SiteResultsContent } from "@/app/biochoco/resultados/[siteId]/site-results-content";
import { formatSiteDateRange } from "@/app/biochoco/resultados/[siteId]/site-header-stats";
import { ContactForm } from "./contact-form";
import { SpeciesCarousel } from "./species-carousel";
import { StoryStat } from "./story-stat";
import { PhotoShareButton } from "@/components/photo-share-button";
import { formatClipDuration } from "@/lib/landowner/format-audio";
import {
  ArrowRight,
  Calendar,
  Film,
  TreePine,
  Volume2,
} from "lucide-react";

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
  const { site, contentBlocks } = data;
  const siteName = site?.siteName ?? data.siteId;
  const habitatLabel = site ? getHabitatName(site.habitatType) : "";

  const resolveImageUrl = (id: number, size: "thumb" | "large") =>
    `/api/public/site-images/${token}/${id}?size=${size}`;

  const speciesHref = (speciesName: string) =>
    `/public/biochoco/${token}/especies/${slugifySpecies(speciesName)}`;

  // Hero: the effective hero image (config/token), else the best species photo.
  const heroImageId =
    data.heroImageId ??
    data.species.find((s) => s.photoImageId != null)?.photoImageId ??
    null;

  const speciesCount = data.species.length;
  const days = data.totalCameraTrapDays;

  const dateRangeLabel = data.dateRange.start
    ? formatSiteDateRange(data.dateRange.start, data.dateRange.end)
    : null;

  return (
    <div className="space-y-8">
      {/* ---- Hero: full-bleed on mobile, framed on desktop ---- */}
      {heroImageId != null ? (
        <div className="relative -mx-4 flex aspect-[4/5] items-end overflow-hidden bg-muted text-white sm:-mx-6 sm:aspect-[16/9] sm:rounded-2xl">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={resolveImageUrl(heroImageId, "large")}
            alt={`Fauna registrada en ${siteName}`}
            className="absolute inset-0 h-full w-full object-cover"
            loading="eager"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />
          <div className="relative w-full p-5 sm:p-6">
            <p className="mb-2 inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] opacity-90">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_0_4px_rgba(230,169,60,0.25)]" />
              Esto vive en su finca
            </p>
            <h1 className="text-3xl font-extrabold leading-[0.98] tracking-tight text-balance drop-shadow-md sm:text-4xl">
              {siteName}
            </h1>
            <div className="mt-3.5 flex flex-wrap gap-1.5">
              {habitatLabel && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/15 px-2.5 py-1 text-xs font-semibold backdrop-blur">
                  <TreePine className="h-3.5 w-3.5" />
                  {habitatLabel}
                </span>
              )}
              {dateRangeLabel && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/15 px-2.5 py-1 text-xs font-semibold backdrop-blur">
                  <Calendar className="h-3.5 w-3.5" />
                  {dateRangeLabel}
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <header className="space-y-3">
          <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Esto vive en su finca
          </p>
          <h1 className="text-3xl font-extrabold tracking-tight">{siteName}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {habitatLabel && (
              <span className="flex items-center gap-1">
                <TreePine className="h-3.5 w-3.5" />
                {habitatLabel}
              </span>
            )}
            {dateRangeLabel && (
              <span className="flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {dateRangeLabel}
              </span>
            )}
          </div>
        </header>
      )}

      {/* ---- Big count-up reveal ---- */}
      <StoryStat speciesCount={speciesCount} days={days} />

      <hr className="border-border" />

      {/* ---- Video message from FCAT (or the "coming soon" placeholder) ---- */}
      {hasIntroVideo ? (
        <video
          controls
          preload="none"
          playsInline
          className="aspect-video w-full rounded-2xl bg-black"
        >
          <source src="/api/public/intro-video" type="video/mp4" />
          Su navegador no puede reproducir este video.
        </video>
      ) : (
        <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-muted/40 px-4 py-10 text-center">
          <Film className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">
            Pronto: un mensaje en video del equipo FCAT
          </p>
          <p className="text-xs text-muted-foreground">
            Estamos preparando un saludo para usted.
          </p>
        </div>
      )}

      {/* Curated content blocks (page-builder), rendered in configured order. */}
      {contentBlocks.map((block, i) => (
        <ContentBlock
          key={`${block.type}-${i}`}
          block={block}
          token={token}
          resolveImageUrl={resolveImageUrl}
        />
      ))}

      <SpeciesCarousel
        species={data.species}
        token={token}
        resolveImageUrl={resolveImageUrl}
      />

      <SiteResultsContent
        data={data}
        audio={null}
        resolveImageUrl={resolveImageUrl}
        speciesHref={speciesHref}
        variant="public"
        shareSiteLabel={siteName}
        showFauna={false}
      />

      <ContactForm token={token} />
    </div>
  );
}

/** Render one resolved page-builder content block. */
function ContentBlock({
  block,
  token,
  resolveImageUrl,
}: {
  block: ResolvedContentBlock;
  token: string;
  resolveImageUrl: (id: number, size: "thumb" | "large") => string;
}) {
  switch (block.type) {
    case "note":
      return (
        <div className="rounded-2xl border border-l-[3px] border-emerald-600/60 border-l-emerald-600 bg-gradient-to-b from-emerald-50 to-card p-5 dark:border-emerald-500/40 dark:border-l-emerald-500 dark:from-emerald-950/40 dark:to-card">
          <p className="font-serif text-[17px] leading-relaxed text-foreground">
            {block.text}
          </p>
          <div className="mt-3.5 flex items-center gap-2.5 text-[13px] text-muted-foreground">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-700 text-[11px] font-extrabold text-white">
              FC
            </span>
            Equipo de monitoreo · FCAT
          </div>
        </div>
      );

    case "summary":
      return (
        <p className="whitespace-pre-line text-[15px] leading-relaxed text-muted-foreground">
          {block.text}
        </p>
      );

    case "featuredPhotos":
      return (
        <section className="space-y-3">
          <div className="space-y-1">
            <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Fotos destacadas
            </p>
            <p className="text-xs text-muted-foreground">
              Algunas de las mejores capturas de su finca
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            {block.imageIds.map((id) => (
            <div
              key={id}
              className="group relative aspect-square overflow-hidden rounded-xl bg-muted"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={resolveImageUrl(id, "large")}
                alt="Fauna registrada en su finca"
                className="h-full w-full object-cover"
                loading="lazy"
              />
                <PhotoShareButton
                  imagePath={resolveImageUrl(id, "large")}
                  caption="Fauna registrada en mi finca — Monitoreo FCAT BioChoco"
                  variant="overlay"
                  className="absolute right-2 top-2"
                />
              </div>
            ))}
          </div>
        </section>
      );

    case "featuredAudio":
      return (
        <div className="space-y-3 rounded-2xl border bg-muted/40 p-5">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 flex-none place-items-center rounded-full bg-gradient-to-b from-emerald-400 to-emerald-600 text-white shadow-md">
              <Volume2 className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                Escuche una grabación de su finca
              </p>
              <p className="text-xs text-muted-foreground">
                Sonidos captados por nuestros grabadores de audio
                {formatClipDuration(block.audio.durationSeconds)
                  ? ` · ${formatClipDuration(block.audio.durationSeconds)}`
                  : ""}
              </p>
            </div>
          </div>
          <audio
            controls
            preload="none"
            className="w-full"
            src={`/api/public/site-audio/${token}/${block.audio.id}`}
          >
            Su navegador no puede reproducir este audio.
          </audio>
        </div>
      );

    case "projectContext":
      return (
        <div className="relative overflow-hidden rounded-2xl bg-emerald-950 p-6 text-emerald-50">
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-emerald-500/25 blur-2xl" />
          <div className="relative space-y-2">
            <h3 className="text-xl font-extrabold tracking-tight">
              Sobre el proyecto BioChoco
            </h3>
            <p className="text-[14.5px] leading-relaxed text-emerald-100/80">
              {block.blurb}
            </p>
            {block.siteCount != null && block.siteCount > 0 && (
              <p className="text-[14.5px] leading-relaxed text-emerald-100/90">
                Junto a{" "}
                <span className="font-extrabold text-amber-400">
                  {block.siteCount}{" "}
                  {block.siteCount === 1 ? "finca" : "fincas"}
                </span>
                , usted contribuye a monitorear la biodiversidad del Chocó.
              </p>
            )}
            <a
              href="/public/biochoco-overview"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 pt-2 text-sm font-bold text-white hover:underline"
            >
              Conozca el proyecto
              <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      );

    default:
      return null;
  }
}
