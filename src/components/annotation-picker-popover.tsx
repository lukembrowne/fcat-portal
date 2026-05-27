"use client";

import { useEffect, useRef, useState } from "react";
import { PopoverContent } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Trash2 } from "lucide-react";
import type { Species } from "@/db/schema";
import type { NameDisplay } from "@/lib/species-display";
import type { AnnotationDetection } from "@/types/annotation";

const TYPE_LABELS: Record<string, string> = {
  mammal: "Mamíferos",
  bird: "Aves",
  system: "Sistema",
  reptile: "Reptiles",
  amphibian: "Anfibios",
  insect: "Insectos",
};

const TYPE_ORDER = ["mammal", "bird", "reptile", "amphibian", "insect", "system"];

function groupByType(speciesList: Species[]): [string, Species[]][] {
  const groups = new Map<string, Species[]>();
  for (const sp of speciesList) {
    const list = groups.get(sp.type) || [];
    list.push(sp);
    groups.set(sp.type, list);
  }
  return TYPE_ORDER.filter((t) => groups.has(t)).map((t) => [t, groups.get(t)!]);
}

/**
 * Relevance scorer for the species search, replacing cmdk's default fuzzy
 * subsequence matcher (which let "chicken" match "Metachirus myosuros"). Each
 * typed token must appear as a substring somewhere in the species' fields
 * (scientific name + common/Spanish names); exact and prefix matches rank
 * highest. Returning 0 hides the item; cmdk floats the highest-scoring item's
 * group to the top, so an exact match surfaces first regardless of taxon group.
 */
function speciesFilter(value: string, search: string, keywords?: string[]): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const fields = [value, ...(keywords ?? [])]
    .map((f) => f.toLowerCase().trim())
    .filter(Boolean);
  const tokens = q.split(/\s+/);
  const haystack = fields.join(" ");
  if (!tokens.every((t) => haystack.includes(t))) return 0;
  let best = 0.3;
  for (const f of fields) {
    if (f === q) return 1;
    if (f.startsWith(q)) best = Math.max(best, 0.9);
    else if (f.split(/[\s/-]+/).some((w) => w.startsWith(q))) best = Math.max(best, 0.6);
  }
  return best;
}

function displayName(sp: Species, mode: NameDisplay): string {
  if (mode === "spanish") return sp.spanishName || sp.commonName || sp.scientificName;
  if (mode === "scientific") return sp.scientificName;
  return sp.commonName || sp.scientificName;
}

interface AnnotationPickerPopoverProps {
  open: boolean;
  selectedDetection: AnnotationDetection | null;
  /** 1-based index of the selected detection in the image's detection list */
  detectionNumber: number;
  currentSpecies: string | null;
  hotkeySlots: Species[];
  /** Most recently assigned species in this session (any image, same job).
   *  Drives the "Última" row + the `0` hotkey for repeating across a 3-photo
   *  burst. Null when nothing has been assigned yet this session. */
  lastSpecies: Species | null;
  speciesList: Species[];
  nameDisplay: NameDisplay;
  canEdit: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onAssignSpecies: (scientificName: string) => void;
  onAssignSpeciesByIndex: (index: number) => void;
  onAssignLastSpecies: () => void;
  onAddSpecies?: () => void;
  onDelete: () => void;
}

export function AnnotationPickerPopover({
  open,
  selectedDetection,
  detectionNumber,
  currentSpecies,
  hotkeySlots,
  lastSpecies,
  speciesList,
  nameDisplay,
  canEdit,
  containerRef,
  searchInputRef,
  onAssignSpecies,
  onAssignSpeciesByIndex,
  onAssignLastSpecies,
  onAddSpecies,
  onDelete,
}: AnnotationPickerPopoverProps) {
  const grouped = groupByType(speciesList);
  const verificationStatus =
    selectedDetection?.identification?.verificationStatus ?? "unclassified";

  // Focus the search input once the popover actually becomes renderable so
  // typing a letter lands in the typeahead immediately. We key off
  // `open && selectedDetection` (the same gate as the render below), not just
  // `open`: when a NEW box is drawn, `open` flips true while `selectedDetection`
  // is still null (it only arrives after the server refresh). Focusing on the
  // bare `open` transition would fire against an unmounted input (no-op) and
  // then never re-fire, leaving the input unfocused. Tracking the renderable
  // transition focuses the input the moment it mounts.
  const isRenderable = open && !!selectedDetection;
  const wasRenderableRef = useRef(false);
  useEffect(() => {
    if (isRenderable && !wasRenderableRef.current) {
      // Defer to the next frame so Radix has finished mounting the content.
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
    wasRenderableRef.current = isRenderable;
  }, [isRenderable, searchInputRef]);

  // Mirror the container ref into state so Radix's `collisionBoundary` gets
  // an Element value, not a ref-access-during-render.
  const [collisionBoundary, setCollisionBoundary] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setCollisionBoundary(containerRef.current);
  }, [open, containerRef]);

  if (!open || !selectedDetection) return null;

  return (
    <PopoverContent
      side="right"
      align="start"
      sideOffset={8}
      collisionPadding={8}
      collisionBoundary={collisionBoundary}
      sticky="partial"
      hideWhenDetached
      avoidCollisions
      onOpenAutoFocus={(e) => {
        // Let our own effect handle focus once Radix is done mounting.
        e.preventDefault();
      }}
      className="w-96 p-0"
    >
      <div className="px-3 py-2 border-b flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium">Detección #{detectionNumber}</span>
          <VerificationBadge status={verificationStatus} />
        </div>
        {canEdit && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={onDelete}
            title="Eliminar (⌫ o Supr)"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {lastSpecies && (
        <div className="px-2 py-2 border-b">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-1">
            Última
          </p>
          {(() => {
            const active = currentSpecies === lastSpecies.scientificName;
            return (
              <button
                type="button"
                disabled={!canEdit || active}
                onClick={onAssignLastSpecies}
                title={`${lastSpecies.scientificName} — Repetir (0)`}
                className={`w-full text-left px-1.5 py-1 rounded text-xs flex items-center gap-1.5 min-w-0 transition-colors ${
                  active
                    ? "bg-primary/10 text-primary cursor-default"
                    : !canEdit
                      ? "opacity-60 cursor-not-allowed"
                      : "hover:bg-accent cursor-pointer"
                }`}
              >
                <Badge
                  variant="outline"
                  className="text-[10px] font-mono w-4 h-4 p-0 flex items-center justify-center shrink-0"
                >
                  0
                </Badge>
                {active && <Check className="h-3 w-3 shrink-0 text-primary" />}
                <span className="truncate">{displayName(lastSpecies, nameDisplay)}</span>
              </button>
            );
          })()}
        </div>
      )}

      {hotkeySlots.length > 0 && (
        <div className="px-2 py-2 border-b">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-1">
            Frecuentes
          </p>
          <div className="grid grid-cols-2 gap-0.5">
            {hotkeySlots.map((sp, idx) => {
              const keyLabel = String(idx + 1);
              const active = currentSpecies === sp.scientificName;
              return (
                <button
                  key={sp.id}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => onAssignSpecies(sp.scientificName)}
                  title={`${sp.scientificName}${sp.commonName ? ` — ${sp.commonName}` : ""}`}
                  className={`w-full text-left px-1.5 py-1 rounded text-xs flex items-center gap-1.5 min-w-0 transition-colors ${
                    active
                      ? "bg-primary/10 text-primary"
                      : !canEdit
                        ? "opacity-60 cursor-not-allowed"
                        : "hover:bg-accent cursor-pointer"
                  }`}
                >
                  <Badge
                    variant="outline"
                    className="text-[10px] font-mono w-4 h-4 p-0 flex items-center justify-center shrink-0"
                  >
                    {keyLabel}
                  </Badge>
                  {active && <Check className="h-3 w-3 shrink-0 text-primary" />}
                  <span className="truncate">{displayName(sp, nameDisplay)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <Command
        loop
        shouldFilter={true}
        filter={speciesFilter}
        className="border-0"
        onKeyDown={(e) => {
          // Backspace/Delete on an empty typeahead deletes the selected bbox.
          // Once the user has typed anything, those keys edit text normally.
          // Mirrors editor norms (e.g. Gmail) and gives a keyboard escape hatch
          // for deletion now that the popover auto-focuses the search input.
          if (
            canEdit &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.shiftKey &&
            (e.key === "Backspace" || e.key === "Delete") &&
            (searchInputRef.current?.value ?? "") === ""
          ) {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
            return;
          }

          // Digits are intercepted here (before cmdk's typeahead) so the user
          // can press 0-9 even while the search input has focus.
          //   1-9 → assign frecuente by slot
          //   0   → repeat last assigned species
          if (
            canEdit &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            /^[0-9]$/.test(e.key)
          ) {
            if (e.key === "0") {
              e.preventDefault();
              e.stopPropagation();
              onAssignLastSpecies();
              return;
            }
            const index = parseInt(e.key, 10) - 1;
            if (index < hotkeySlots.length) {
              e.preventDefault();
              e.stopPropagation();
              onAssignSpeciesByIndex(index);
            }
          }
        }}
      >
        <CommandInput
          ref={searchInputRef}
          placeholder="Buscar otra especie..."
          className="h-9"
        />
        <CommandList className="max-h-64">
          <CommandEmpty>
            <div className="flex flex-col items-center gap-2 py-2 text-xs">
              <span className="text-muted-foreground">No se encontraron especies.</span>
              {canEdit && onAddSpecies && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={onAddSpecies}
                >
                  Agregar nueva especie
                </Button>
              )}
            </div>
          </CommandEmpty>
          {grouped.map(([type, items]) => (
            <CommandGroup key={type} heading={TYPE_LABELS[type] || type}>
              {items.map((sp) => (
                <CommandItem
                  key={sp.id}
                  value={sp.scientificName}
                  keywords={[sp.commonName, sp.spanishName ?? ""]}
                  onSelect={() => canEdit && onAssignSpecies(sp.scientificName)}
                  disabled={!canEdit}
                  className="text-xs"
                >
                  {currentSpecies === sp.scientificName && (
                    <Check className="h-3 w-3 mr-1 shrink-0 text-primary" />
                  )}
                  <span className={nameDisplay === "scientific" ? "italic" : ""}>
                    {displayName(sp, nameDisplay)}
                  </span>
                  <span className="ml-auto text-muted-foreground text-[10px] italic">
                    {sp.scientificName}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </PopoverContent>
  );
}

function VerificationBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    verified: { label: "Verificada", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
    corrected: { label: "Corregida", className: "bg-blue-100 text-blue-800 border-blue-200" },
    rejected: { label: "Rechazada", className: "bg-red-100 text-red-800 border-red-200" },
    unverified: { label: "Sin verificar", className: "bg-amber-100 text-amber-800 border-amber-200" },
    unclassified: { label: "Sin clasificar", className: "bg-slate-100 text-slate-700 border-slate-200" },
  };
  const entry = map[status] ?? map.unverified;
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${entry.className}`}>
      {entry.label}
    </Badge>
  );
}
