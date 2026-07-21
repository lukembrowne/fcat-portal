/**
 * Public species gallery sub-route.
 *
 * Renders every verified image of a species at the site, paginated.
 * The page shell (header, back link, pagination) is server-rendered so
 * the page still loads and paginates without JavaScript. The thumbnail
 * grid is a small Client Component (`GalleryClient`) that progressively
 * enhances clicks into a zoomable image viewer dialog. Download links
 * stay as plain <a download> anchors both in the grid and inside the
 * dialog, so downloads keep working in JS-restricted browsers like
 * WhatsApp's in-app view even if the enhancement layer breaks.
 *
 * URL shape:
 *   /public/biochoco/[token]/especies/[slug]?page=2
 *
 * Slug is the species scientific name lowercased with spaces replaced
 * by hyphens (URL-encoded). The page resolves the slug back to the
 * species name by matching against the site's species list on the
 * cached fetchSiteDetailByToken result.
 */

import type { Metadata } from "next";
import Link from "next/link";
import {
  fetchSiteDetailByToken,
  fetchSpeciesImagesForDeployments,
} from "@/app/biochoco/resultados/actions";
import { ChevronLeft, ChevronRight, ArrowLeft } from "lucide-react";
import { GalleryClient } from "./gallery-client";

interface PageProps {
  params: Promise<{ token: string; slug: string }>;
  searchParams: Promise<{ page?: string }>;
}

const PAGE_SIZE = 50;

function speciesSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

function decodeSlug(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

function parsePage(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token, slug } = await params;
  const data = await fetchSiteDetailByToken(token);
  if (!data) return { title: "Enlace no válido — Portal FCAT" };

  const decoded = decodeSlug(slug);
  const sp = data.species.find((s) => speciesSlug(s.speciesName) === decoded);
  const display = sp?.spanishName ?? sp?.commonName ?? sp?.speciesName ?? "";
  const siteName = data.site?.siteName ?? data.siteId;

  return {
    title: `${display} — ${siteName} — Portal FCAT`,
    robots: { index: false, follow: false },
  };
}

export default async function PublicSpeciesGalleryPage({
  params,
  searchParams,
}: PageProps) {
  const [{ token, slug }, sp] = await Promise.all([params, searchParams]);

  const data = await fetchSiteDetailByToken(token);
  if (!data) {
    return (
      <div className="text-center py-20 space-y-3">
        <h1 className="text-2xl font-bold">Este enlace ya no es válido</h1>
        <p className="text-muted-foreground">
          El enlace que has seguido ha sido revocado o no existe.
        </p>
      </div>
    );
  }

  const decoded = decodeSlug(slug);
  const species = data.species.find(
    (s) => speciesSlug(s.speciesName) === decoded
  );

  if (!species) {
    return (
      <div className="text-center py-20 space-y-3">
        <h1 className="text-2xl font-bold">Especie no encontrada</h1>
        <p className="text-muted-foreground">
          Esta especie no aparece en los resultados de este sitio.
        </p>
        <p>
          <Link
            href={`/public/biochoco/${token}`}
            className="text-blue-600 hover:underline"
          >
            ← Volver al sitio
          </Link>
        </p>
      </div>
    );
  }

  const page = parsePage(sp.page);
  const result = await fetchSpeciesImagesForDeployments(
    data.deploymentIds,
    species.speciesName,
    page,
    PAGE_SIZE
  );

  const totalPages = Math.max(1, Math.ceil(result.totalCount / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const hasPrev = safePage > 1;
  const hasNext = safePage < totalPages;

  const display = species.spanishName ?? species.commonName ?? species.speciesName;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <p>
        <Link
          href={`/public/biochoco/${token}`}
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Volver al sitio
        </Link>
      </p>

      {/* Header */}
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{display}</h1>
        <p className="text-sm text-muted-foreground italic">
          {species.speciesName}
        </p>
        <p className="text-sm text-muted-foreground">
          {species.detectionCount}{" "}
          {species.detectionCount === 1 ? "detección" : "detecciones"} ·{" "}
          {result.totalCount}{" "}
          {result.totalCount === 1 ? "imagen" : "imágenes"}
        </p>
      </header>

      {/* Image grid (client-enhanced with zoomable viewer) */}
      {result.images.length === 0 ? (
        <p className="text-muted-foreground py-10 text-center">
          No hay imágenes disponibles en esta página.
        </p>
      ) : (
        <GalleryClient
          token={token}
          siteId={data.siteId}
          speciesLabel={display}
          images={result.images}
        />
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <nav
          className="flex items-center justify-between pt-4"
          aria-label="Paginación"
        >
          {hasPrev ? (
            <Link
              href={
                safePage - 1 === 1
                  ? `/public/biochoco/${token}/especies/${slug}`
                  : `/public/biochoco/${token}/especies/${slug}?page=${safePage - 1}`
              }
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-muted hover:bg-muted/80"
            >
              <ChevronLeft className="h-4 w-4" />
              Anterior
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground">
            Página {safePage} de {totalPages}
          </span>
          {hasNext ? (
            <Link
              href={`/public/biochoco/${token}/especies/${slug}?page=${safePage + 1}`}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-muted hover:bg-muted/80"
            >
              Siguiente
              <ChevronRight className="h-4 w-4" />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}

