"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PublicSiteDetail,
  ResolvedContentBlock,
} from "@/app/biochoco/resultados/actions";
import { getHabitatName } from "@/app/biochoco/overview/types";
import { SiteResultsContent } from "@/app/biochoco/resultados/[siteId]/site-results-content";
import { formatSiteDateRange } from "@/app/biochoco/resultados/[siteId]/site-header-stats";
import { ContactForm } from "./contact-form";
import { SpeciesShowcase } from "./species-showcase";
import { StoryStat } from "./story-stat";
import { PageShare } from "./page-share";
import { PhotoShareButton } from "@/components/photo-share-button";
import { formatClipDuration } from "@/lib/landowner/format-audio";
import {
  starredGallerySeed,
  landownerDisplayName,
  lightboxArrowState,
  LIGHTBOX_NEXT_LABEL,
  LIGHTBOX_PREV_LABEL,
} from "@/lib/landowner/copy";
import {
  ArrowRight,
  Calendar,
  Expand,
  Film,
  TreePine,
  Volume2,
  X,
  ChevronLeft,
  ChevronRight,
  Download,
} from "lucide-react";

interface PublicSiteShellProps {
  data: PublicSiteDetail;
  token: string;
  /** Whether a fixed intro/thank-you video is configured (server-resolved). */
  hasIntroVideo?: boolean;
  /**
   * All starred image ids for the site (token-gated server fetch). Seeds the
   * fullscreen featured-photo gallery (U11); empty when the site has none.
   */
  starredImageIds?: number[];
  /** Absolute public URL of this page, for the page-level share buttons. */
  publicUrl?: string;
}

function slugifySpecies(name: string): string {
  return encodeURIComponent(name.toLowerCase().replace(/\s+/g, "-"));
}

export function PublicSiteShell({
  data,
  token,
  hasIntroVideo = false,
  starredImageIds = [],
  publicUrl = "",
}: PublicSiteShellProps) {
  const { site, contentBlocks } = data;
  const siteName = site?.siteName ?? data.siteId;
  // Public hero leads with the landowner's name, dropping the internal code.
  const displayName = landownerDisplayName(siteName);
  const habitatLabel = site ? getHabitatName(site.habitatType) : "";

  // Fullscreen featured-photo gallery (U11): a tapped tile seeds it from the
  // full starred set, falling back to the block's own ids when none are starred.
  const [gallery, setGallery] = useState<{
    ids: number[];
    startIndex: number;
  } | null>(null);
  const openStarredGallery = useCallback(
    (blockImageIds: number[], tappedId: number) => {
      setGallery(starredGallerySeed(starredImageIds, blockImageIds, tappedId));
    },
    [starredImageIds],
  );
  // Species showcase: open the swipe lightbox over that species' resolved
  // gallery ids directly (one click), starting at the tapped image.
  const openSpeciesGallery = useCallback((ids: number[], tappedId: number) => {
    if (ids.length === 0) return;
    setGallery({ ids, startIndex: Math.max(0, ids.indexOf(tappedId)) });
  }, []);

  // projectContext is force-appended LAST by the resolver, but the public page
  // shows it directly under the video (U6). Pull it out of the config-ordered
  // stream and render it in that fixed slot; keep exactly one.
  const projectContextBlock =
    contentBlocks.find((b) => b.type === "projectContext") ?? null;
  const orderedBlocks = contentBlocks.filter(
    (b) => b.type !== "projectContext",
  );

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
    <div>
      {/* ---- Full-bleed camera-trap hero, top-flush to the viewport (U5).
           This route lives OUTSIDE the (chrome) route group, so there is no
           header bar or page padding above it: the image reaches the top edge
           and runs the full viewport width at every breakpoint. The FCAT /
           BioChoco wordmark (previously in the chrome header) is folded into
           the scrim, top-left. ---- */}
      {heroImageId != null && (
        <div className="relative flex aspect-[4/5] items-end overflow-hidden bg-muted text-white sm:aspect-[16/9]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={resolveImageUrl(heroImageId, "large")}
            alt={`Fauna registrada en ${siteName}`}
            className="absolute inset-0 h-full w-full object-cover"
            loading="eager"
          />
          {/* Bottom scrim for the title, top scrim for the wordmark. */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />
          <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/45 to-transparent" />

          {/* FCAT / BioChoco branding folded into the hero overlay. */}
          <div className="absolute inset-x-0 top-0">
            <div className="mx-auto flex max-w-5xl items-center gap-2.5 p-5 sm:p-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo-fcat.png"
                alt="FCAT"
                className="h-9 w-auto flex-none rounded bg-white/90 p-1 shadow-sm"
              />
              <span className="text-base font-bold tracking-tight drop-shadow-md sm:text-lg">
                BioChocó
              </span>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-5xl p-5 sm:p-6">
            <p className="mb-2 inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] opacity-90">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_0_4px_rgba(230,169,60,0.25)]" />
              Esto vive en su tierra
            </p>
            <h1 className="text-3xl font-extrabold leading-[0.98] tracking-tight text-balance drop-shadow-md sm:text-4xl">
              {displayName}
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
      )}

      {/* Body content: constrained + padded (the (chrome) main wrapper that used
          to supply this is gone now that the route is full-bleed). */}
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-6">
        {heroImageId == null && (
          <header className="space-y-3">
            {/* Text wordmark stands in for the removed chrome header when there
                is no hero image to fold the logo into. */}
            <span className="block text-lg font-semibold">BioChocó</span>
            <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Esto vive en su tierra
            </p>
            <h1 className="text-3xl font-extrabold tracking-tight">{displayName}</h1>
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

      {/* "Sobre el proyecto BioChoco" sits directly under the video (U6). */}
      {projectContextBlock && (
        <ContentBlock
          block={projectContextBlock}
          token={token}
          resolveImageUrl={resolveImageUrl}
        />
      )}

      {/* Curated content blocks (page-builder), rendered in configured order. */}
      {orderedBlocks.map((block, i) => (
        <ContentBlock
          key={`${block.type}-${i}`}
          block={block}
          token={token}
          resolveImageUrl={resolveImageUrl}
          onTapPhoto={openStarredGallery}
        />
      ))}

      <SpeciesShowcase
        species={data.species}
        resolveImageUrl={resolveImageUrl}
        speciesHref={speciesHref}
        onTapPhoto={openSpeciesGallery}
      />

      <SiteResultsContent
        data={data}
        audio={null}
        resolveImageUrl={resolveImageUrl}
        speciesHref={speciesHref}
        variant="public"
        shareSiteLabel={displayName}
        showFauna={false}
      />

      {/* Page-level share, just above the footer. */}
      <PageShare publicUrl={publicUrl} title={displayName} />

      <ContactForm token={token} />

        {gallery && (
          <StarredGalleryLightbox
            ids={gallery.ids}
            startIndex={gallery.startIndex}
            resolveImageUrl={resolveImageUrl}
            onClose={() => setGallery(null)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Fullscreen swipe gallery over an explicit set of image ids (U11). Mirrors the
 * `SpeciesLightbox` look/behaviour (desktop arrows, swipe, Escape/backdrop/X to
 * close, body-scroll lock) but takes ids directly — no per-species fetch — so it
 * can show the site's full starred set starting at the tapped tile.
 */
function StarredGalleryLightbox({
  ids,
  startIndex,
  resolveImageUrl,
  onClose,
}: {
  ids: number[];
  startIndex: number;
  resolveImageUrl: (id: number, size: "thumb" | "large") => string;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(startIndex);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const total = ids.length;

  // Close on Escape + lock body scroll while open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Jump to the tapped image once the track has laid out.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollTo({ left: startIndex * el.clientWidth });
  }, [startIndex]);

  const onScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    setCurrent((prev) => (prev === idx ? prev : idx));
  }, []);

  const scrollToIndex = useCallback(
    (idx: number) => {
      const el = trackRef.current;
      if (!el) return;
      const clamped = Math.max(0, Math.min(idx, total - 1));
      el.scrollTo({ left: clamped * el.clientWidth });
    },
    [total],
  );

  const { showPrev, showNext } = lightboxArrowState(current, total);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Fotos destacadas"
      onClick={onClose}
    >
      <div
        className="flex items-start justify-between gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="truncate text-lg font-extrabold leading-tight tracking-tight">
          Fotos destacadas
        </h2>
        <div className="flex flex-none items-center gap-3">
          {total > 0 && (
            <span className="text-xs font-semibold tabular-nums text-white/80">
              {Math.min(current + 1, total)} / {total}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/10 p-2 hover:bg-white/20"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div
        className="group relative flex-1 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {showPrev && (
          <button
            type="button"
            onClick={() => scrollToIndex(current - 1)}
            aria-label={LIGHTBOX_PREV_LABEL}
            className="absolute left-3 top-1/2 z-20 hidden -translate-y-1/2 rounded-full bg-white/10 p-2.5 opacity-0 transition hover:bg-white/20 focus-visible:opacity-100 group-hover:opacity-100 sm:flex"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {showNext && (
          <button
            type="button"
            onClick={() => scrollToIndex(current + 1)}
            aria-label={LIGHTBOX_NEXT_LABEL}
            className="absolute right-3 top-1/2 z-20 hidden -translate-y-1/2 rounded-full bg-white/10 p-2.5 opacity-0 transition hover:bg-white/20 focus-visible:opacity-100 group-hover:opacity-100 sm:flex"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
        <div
          ref={trackRef}
          onScroll={onScroll}
          className="flex h-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden scroll-smooth motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden"
        >
          {ids.map((id) => {
            const largeUrl = resolveImageUrl(id, "large");
            return (
              <div
                key={id}
                className="relative flex h-full w-full flex-none snap-center items-center justify-center"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={largeUrl}
                  alt="Fauna registrada en su tierra"
                  className="max-h-full max-w-full select-none object-contain"
                  loading="lazy"
                  draggable={false}
                />
                <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
                  <a
                    href={`${largeUrl}&download=1`}
                    download={`FCAT-foto-${id}.jpg`}
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Descargar foto"
                    className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-2 text-xs font-semibold text-white backdrop-blur hover:bg-white/20"
                  >
                    <Download className="h-4 w-4" />
                    <span className="hidden sm:inline">Descargar</span>
                  </a>
                  <PhotoShareButton
                    imagePath={largeUrl}
                    caption="Fauna registrada en mi finca — Monitoreo FCAT BioChocó"
                    variant="overlay"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Render one resolved page-builder content block. */
function ContentBlock({
  block,
  token,
  resolveImageUrl,
  onTapPhoto,
}: {
  block: ResolvedContentBlock;
  token: string;
  resolveImageUrl: (id: number, size: "thumb" | "large") => string;
  /** Open the fullscreen starred gallery starting at the tapped image (U11). */
  onTapPhoto?: (blockImageIds: number[], tappedId: number) => void;
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
                <button
                  type="button"
                  onClick={() => onTapPhoto?.(block.imageIds, id)}
                  className="absolute inset-0 block h-full w-full cursor-zoom-in"
                  aria-label="Ver foto en pantalla completa"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={resolveImageUrl(id, "large")}
                    alt="Fauna registrada en su tierra"
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <span className="pointer-events-none absolute bottom-2 left-2 grid h-7 w-7 place-items-center rounded-md bg-black/50 text-white opacity-90 transition group-hover:bg-black/70">
                    <Expand className="h-3.5 w-3.5" />
                  </span>
                </button>
                <PhotoShareButton
                  imagePath={resolveImageUrl(id, "large")}
                  caption="Fauna registrada en mi finca — Monitoreo FCAT BioChocó"
                  variant="overlay"
                  className="absolute right-2 top-2 z-10"
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
          <ul className="space-y-1.5 text-[13px] leading-relaxed text-muted-foreground">
            <li className="flex gap-2">
              <span aria-hidden className="text-emerald-600">
                •
              </span>
              <span>
                Revelan qué especies viven aquí — sobre todo las aves y las
                ranas, que reconocemos por su canto.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-emerald-600">
                •
              </span>
              <span>
                Muestran a qué horas hay más actividad, de día y de noche.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-emerald-600">
                •
              </span>
              <span>
                Dan una idea de la salud del bosque, captada sin molestar a los
                animales.
              </span>
            </li>
          </ul>
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
              Sobre el proyecto BioChocó
            </h3>
            <p className="text-[14.5px] leading-relaxed text-emerald-100/80">
              {block.blurb}
            </p>
            {block.siteCount != null && block.siteCount > 0 && (
              <p className="text-[14.5px] leading-relaxed text-emerald-100/90">
                Junto a{" "}
                <span className="font-extrabold text-amber-400">
                  {block.siteCount}{" "}
                  {block.siteCount === 1 ? "sitio" : "sitios"}
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
