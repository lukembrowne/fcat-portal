"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  SpeciesDisplayProvider,
  useSpeciesDisplay,
  DISPLAY_LABELS,
  type SpeciesNameInfo,
} from "@/lib/species-display";
import type {
  StarredImageEntry,
  StarredSpeciesEntry,
} from "@/app/camera-trap/actions";

const NO_SPECIES_KEY = "__no_species__";

interface FavoritesClientProps {
  images: StarredImageEntry[];
  speciesList: StarredSpeciesEntry[];
}

type GroupMode = "site" | "species";

export function FavoritesClient({ images, speciesList }: FavoritesClientProps) {
  const speciesInfo: SpeciesNameInfo[] = useMemo(
    () =>
      speciesList.map((s) => ({
        scientificName: s.scientificName,
        commonName: s.commonName,
        spanishName: s.spanishName,
      })),
    [speciesList]
  );

  return (
    <SpeciesDisplayProvider speciesInfo={speciesInfo}>
      <FavoritesClientInner images={images} speciesList={speciesList} />
    </SpeciesDisplayProvider>
  );
}

function FavoritesClientInner({
  images,
  speciesList,
}: FavoritesClientProps) {
  const [selectedSpecies, setSelectedSpecies] = useState<string | null>(null);
  const [groupMode, setGroupMode] = useState<GroupMode>("site");
  const [openImageId, setOpenImageId] = useState<number | null>(null);

  const display = useSpeciesDisplay();

  const filteredImages = useMemo(() => {
    if (!selectedSpecies) return images;
    return images.filter((img) => img.species.includes(selectedSpecies));
  }, [images, selectedSpecies]);

  const groups = useMemo(() => {
    const map = new Map<
      string,
      { key: string; label: string; images: StarredImageEntry[] }
    >();

    const push = (key: string, label: string, img: StarredImageEntry) => {
      const g = map.get(key) ?? { key, label, images: [] };
      g.images.push(img);
      map.set(key, g);
    };

    if (groupMode === "site") {
      for (const img of filteredImages) {
        const label = img.siteName || img.deploymentName || "Sin sitio";
        push(label, label, img);
      }
    } else {
      for (const img of filteredImages) {
        if (img.species.length === 0) {
          push(NO_SPECIES_KEY, "Sin especie", img);
          continue;
        }
        for (const sp of img.species) {
          push(sp, sp, img);
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      // "Sin especie" / "Sin sitio" last
      if (a.key === NO_SPECIES_KEY) return 1;
      if (b.key === NO_SPECIES_KEY) return -1;
      return b.images.length - a.images.length;
    });
  }, [filteredImages, groupMode]);

  const openImage = useMemo(
    () =>
      openImageId != null
        ? images.find((i) => i.id === openImageId) ?? null
        : null,
    [openImageId, images]
  );

  const hasActiveFilters = selectedSpecies !== null;

  const renderSpeciesLabel = (sp: StarredSpeciesEntry) => {
    if (!display) return sp.commonName || sp.scientificName;
    return display.getName(sp.scientificName);
  };

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Sidebar */}
        <div className="space-y-3">
          <Card className="gap-0 py-0">
            <CardHeader className="pb-2 pt-3 px-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Filtros</CardTitle>
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-auto py-0.5 px-1.5"
                    onClick={() => setSelectedSpecies(null)}
                  >
                    Limpiar
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3 px-3 pb-3">
              {/* Grouping toggle */}
              <div className="space-y-1.5">
                <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Agrupar por
                </Label>
                <div className="inline-flex rounded-md border bg-background p-0.5 w-full">
                  <button
                    type="button"
                    onClick={() => setGroupMode("site")}
                    className={cn(
                      "flex-1 text-xs py-1 px-2 rounded-sm transition-colors",
                      groupMode === "site"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Sitio
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupMode("species")}
                    className={cn(
                      "flex-1 text-xs py-1 px-2 rounded-sm transition-colors",
                      groupMode === "species"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Especie
                  </button>
                </div>
              </div>

              {/* Species filter */}
              {speciesList.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      Especie{" "}
                      <span className="text-muted-foreground/70 normal-case tracking-normal">
                        ({speciesList.length})
                      </span>
                    </Label>
                    {display && (
                      <button
                        type="button"
                        onClick={display.cycle}
                        className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border transition-colors"
                        title="Cambiar formato de nombre"
                      >
                        {DISPLAY_LABELS[display.nameDisplay]}
                      </button>
                    )}
                  </div>
                  <div className="relative rounded-md border bg-background/40">
                    <div
                      className="space-y-1 max-h-64 overflow-y-auto p-1 [scrollbar-width:thin]"
                      style={{ scrollbarGutter: "stable" }}
                    >
                      {speciesList.map((sp) => {
                        const selected = selectedSpecies === sp.scientificName;
                        return (
                          <button
                            key={sp.scientificName}
                            type="button"
                            onClick={() =>
                              setSelectedSpecies(
                                selected ? null : sp.scientificName
                              )
                            }
                            className={cn(
                              "w-full flex items-center justify-between gap-2 text-left text-xs px-2 py-1 rounded-sm transition-colors",
                              selected
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-muted"
                            )}
                          >
                            <span className="truncate italic">
                              {renderSpeciesLabel(sp)}
                            </span>
                            <span
                              className={cn(
                                "text-[10px] tabular-nums shrink-0",
                                selected
                                  ? "text-primary-foreground/80"
                                  : "text-muted-foreground"
                              )}
                            >
                              {sp.count}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Grid area */}
        <div className="space-y-6">
          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Ninguna imagen coincide con los filtros seleccionados.
            </p>
          )}
          {groups.map((group) => (
            <section key={group.key}>
              <div className="flex items-baseline gap-2 mb-2">
                <h2 className="text-lg font-semibold">
                  {groupMode === "species" && group.key !== NO_SPECIES_KEY ? (
                    <span className="italic">
                      {display?.getName(group.key) ?? group.label}
                    </span>
                  ) : (
                    group.label
                  )}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {group.images.length}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {group.images.map((image) => (
                  <FavoriteCard
                    key={`${group.key}-${image.id}`}
                    image={image}
                    onClick={() => setOpenImageId(image.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      <Dialog
        open={openImage !== null}
        onOpenChange={(open) => {
          if (!open) setOpenImageId(null);
        }}
      >
        <DialogContent className="sm:max-w-4xl p-0 gap-0 overflow-hidden">
          {openImage && (
            <>
              <div className="bg-black flex items-center justify-center max-h-[70vh] overflow-hidden">
                <img
                  src={`/api/ct-images/${openImage.id}?size=full`}
                  alt={openImage.filename}
                  className="max-h-[70vh] w-auto object-contain"
                />
              </div>
              <DialogHeader className="px-4 pt-3 pb-1">
                <DialogTitle className="text-base truncate">
                  {openImage.filename}
                </DialogTitle>
                <DialogDescription className="text-xs">
                  {openImage.siteName
                    ? `${openImage.siteName} · ${openImage.deploymentName}`
                    : openImage.deploymentName}
                </DialogDescription>
              </DialogHeader>
              <div className="px-4 pb-3 space-y-2">
                {openImage.species.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {openImage.species.map((sp) => (
                      <Badge
                        key={sp}
                        variant="secondary"
                        className="text-[11px] italic"
                      >
                        {display?.getName(sp) ?? sp}
                      </Badge>
                    ))}
                  </div>
                )}
                {openImage.starredBy && (
                  <p className="text-[11px] text-muted-foreground">
                    Destacada por {openImage.starredBy}
                    {openImage.starredAt && (
                      <>
                        {" · "}
                        {new Date(openImage.starredAt).toLocaleDateString(
                          "es-EC"
                        )}
                      </>
                    )}
                  </p>
                )}
              </div>
              <DialogFooter className="px-4 py-3 border-t bg-muted/30">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOpenImageId(null)}
                >
                  Cerrar
                </Button>
                {openImage.jobId != null && (
                  <Button asChild size="sm">
                    <Link
                      href={`/camera-trap/results/${openImage.jobId}/images/${openImage.id}`}
                    >
                      Ir a anotación
                    </Link>
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function FavoriteCard({
  image,
  onClick,
}: {
  image: StarredImageEntry;
  onClick: () => void;
}) {
  const thumbUrl = `/api/ct-images/${image.id}?size=thumb`;

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-[4/3] rounded-lg overflow-hidden border bg-muted cursor-pointer hover:ring-2 hover:ring-primary transition-all text-left"
    >
      <img
        src={thumbUrl}
        alt={image.filename}
        className="w-full h-full object-cover"
        loading="lazy"
      />

      {/* Star badge */}
      <div className="absolute top-2 left-2 z-10">
        <svg
          className="size-5 text-amber-400 drop-shadow"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
        </svg>
      </div>

      {/* Deployment info overlay */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 pt-6">
        <p className="text-white text-xs font-medium truncate">
          {image.deploymentName}
        </p>
        {image.siteName && (
          <p className="text-white/70 text-[10px] truncate">{image.siteName}</p>
        )}
      </div>

      {image.jobId == null && (
        <div className="absolute top-2 right-2">
          <Badge variant="outline" className="bg-white/80 text-[10px]">
            Sin trabajo
          </Badge>
        </div>
      )}
    </button>
  );
}
