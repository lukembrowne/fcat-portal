"use client";

/**
 * Per-species photo curator for the finca page builder.
 *
 * Lets the team browse EVERY photo of a species (scoped to the site's active
 * token) and star the ones that should lead that species' public gallery.
 * Starring reuses biochoco_images.starred — the same flag the "Fotos
 * destacadas" picker reads — and the public per-species gallery
 * (fetchSpeciesGalleryImages) shows starred photos first, falling back to an
 * auto-capped sample when nothing is starred.
 *
 * Mounted as its own section in the builder shell, decoupled from the page
 * config so it never touches the fragile block editor.
 */

import { useState, useTransition } from "react";
import { Star, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  fetchCurationSpecies,
  fetchSpeciesPhotosForCuration,
  toggleSpeciesPhotoStar,
  type CurationSpecies,
  type CurationPhoto,
} from "../../resultados/actions";

interface Props {
  siteId: string;
  token: string;
}

export function SpeciesPhotoCurator({ siteId, token }: Props) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [speciesList, setSpeciesList] = useState<CurationSpecies[]>([]);
  const [activeSpecies, setActiveSpecies] = useState<string | null>(null);

  const thumb = (id: number) =>
    `/api/public/site-images/${token}/${id}?size=thumb`;

  const openSection = async () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded) {
      setLoading(true);
      try {
        const list = await fetchCurationSpecies(siteId);
        setSpeciesList(list);
        setLoaded(true);
      } finally {
        setLoading(false);
      }
    }
  };

  const bumpStarredCount = (speciesName: string, delta: number) => {
    setSpeciesList((list) =>
      list.map((s) =>
        s.speciesName === speciesName
          ? { ...s, starredCount: Math.max(0, s.starredCount + delta) }
          : s
      )
    );
  };

  return (
    <section className="rounded-xl border bg-card">
      <button
        type="button"
        onClick={openSection}
        className="flex w-full items-center justify-between gap-2 p-4 text-left"
      >
        <span>
          <span className="flex items-center gap-2 font-semibold">
            <Star className="h-4 w-4 text-amber-500" />
            Fotos destacadas por especie
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Marque con ★ las mejores fotos de cada especie. Aparecerán primero en
            la galería que ve el propietario.
          </span>
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="border-t p-4">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando especies…
            </p>
          ) : speciesList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hay especies con fotos en este sitio.
            </p>
          ) : (
            <div className="space-y-2">
              {speciesList.map((s) => (
                <SpeciesRow
                  key={s.speciesName}
                  siteId={siteId}
                  species={s}
                  isActive={activeSpecies === s.speciesName}
                  onToggleOpen={() =>
                    setActiveSpecies((cur) =>
                      cur === s.speciesName ? null : s.speciesName
                    )
                  }
                  thumb={thumb}
                  onStarChange={bumpStarredCount}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SpeciesRow({
  siteId,
  species,
  isActive,
  onToggleOpen,
  thumb,
  onStarChange,
}: {
  siteId: string;
  species: CurationSpecies;
  isActive: boolean;
  onToggleOpen: () => void;
  thumb: (id: number) => string;
  onStarChange: (speciesName: string, delta: number) => void;
}) {
  const [photos, setPhotos] = useState<CurationPhoto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    onToggleOpen();
    if (!isActive && photos === null) {
      setLoading(true);
      try {
        const p = await fetchSpeciesPhotosForCuration(siteId, species.speciesName);
        setPhotos(p);
      } finally {
        setLoading(false);
      }
    }
  };

  const toggle = (photo: CurationPhoto) => {
    setError(null);
    // Optimistic flip.
    const next = !photo.starred;
    setPhotos((ps) =>
      ps ? ps.map((p) => (p.id === photo.id ? { ...p, starred: next } : p)) : ps
    );
    onStarChange(species.speciesName, next ? 1 : -1);
    startTransition(async () => {
      const result = await toggleSpeciesPhotoStar(siteId, photo.id);
      if (!result.success) {
        // Roll back on failure.
        setPhotos((ps) =>
          ps
            ? ps.map((p) => (p.id === photo.id ? { ...p, starred: photo.starred } : p))
            : ps
        );
        onStarChange(species.speciesName, next ? -1 : 1);
        setError(result.error);
      } else if (result.data.starred !== next) {
        // Reconcile to server truth if it diverged.
        setPhotos((ps) =>
          ps
            ? ps.map((p) =>
                p.id === photo.id ? { ...p, starred: result.data.starred } : p
              )
            : ps
        );
      }
    });
  };

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
      >
        <span className="min-w-0 truncate font-medium">{species.label}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {species.starredCount > 0 && (
            <span className="inline-flex items-center gap-0.5 text-amber-600">
              <Star className="h-3 w-3 fill-amber-500 text-amber-500" />
              {species.starredCount}
            </span>
          )}
          <span>{species.detectionCount} fotos</span>
          {isActive ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </span>
      </button>

      {isActive && (
        <div className="border-t p-3">
          {loading ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Cargando fotos…
            </p>
          ) : !photos || photos.length === 0 ? (
            <p className="text-xs text-muted-foreground">No hay fotos.</p>
          ) : (
            <>
              {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                {photos.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggle(p)}
                    disabled={isPending}
                    title={p.starred ? "Quitar de destacadas" : "Marcar como destacada"}
                    className={`relative aspect-square overflow-hidden rounded border-2 ${
                      p.starred ? "border-amber-500" : "border-transparent"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumb(p.id)}
                      alt={p.filename}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    <span
                      className={`absolute right-0.5 top-0.5 rounded-full p-0.5 ${
                        p.starred
                          ? "bg-amber-500 text-white"
                          : "bg-black/40 text-white/80"
                      }`}
                    >
                      <Star
                        className={`h-3 w-3 ${p.starred ? "fill-white" : ""}`}
                      />
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
