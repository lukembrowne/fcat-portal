"use client";

import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Check, Search } from "lucide-react";
import type { Species } from "@/db/schema";

export type NameDisplay = "common" | "spanish" | "scientific";
export const DISPLAY_KEY = "species-name-display";

export function getStoredDisplay(): NameDisplay {
  if (typeof window === "undefined") return "common";
  const stored = localStorage.getItem(DISPLAY_KEY);
  if (stored === "common" || stored === "spanish" || stored === "scientific") return stored;
  return "common";
}

const DISPLAY_LABELS: Record<NameDisplay, string> = {
  common: "Inglés",
  spanish: "Español",
  scientific: "Científico",
};

const TYPE_LABELS: Record<string, string> = {
  mammal: "Mamíferos",
  bird: "Aves",
  system: "Sistema",
  reptile: "Reptiles",
  amphibian: "Anfibios",
  insect: "Insectos",
};

const TYPE_ORDER = ["mammal", "bird", "reptile", "amphibian", "insect", "system"];

interface SpeciesSidebarProps {
  speciesList: Species[];
  frequentSpecies: Species[];
  selectedDetectionId: number | null;
  currentSpecies: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectSpecies?: (scientificName: string) => void;
  onAddSpecies?: () => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  nameDisplay: NameDisplay;
  onCycleDisplay: () => void;
}

function groupByType(speciesList: Species[]): [string, Species[]][] {
  const groups = new Map<string, Species[]>();
  for (const sp of speciesList) {
    const list = groups.get(sp.type) || [];
    list.push(sp);
    groups.set(sp.type, list);
  }
  return TYPE_ORDER
    .filter((t) => groups.has(t))
    .map((t) => [t, groups.get(t)!]);
}

export function SpeciesSidebar({
  speciesList,
  frequentSpecies,
  selectedDetectionId,
  currentSpecies,
  searchQuery,
  onSearchChange,
  onSelectSpecies,
  onAddSpecies,
  searchInputRef,
  nameDisplay,
  onCycleDisplay,
}: SpeciesSidebarProps) {
  const filteredSpecies = useMemo(() => {
    if (!searchQuery.trim()) return speciesList;
    const q = searchQuery.toLowerCase();
    return speciesList.filter(
      (sp) =>
        sp.scientificName.toLowerCase().includes(q) ||
        sp.commonName.toLowerCase().includes(q) ||
        (sp.spanishName && sp.spanishName.toLowerCase().includes(q))
    );
  }, [speciesList, searchQuery]);

  const grouped = useMemo(() => groupByType(filteredSpecies), [filteredSpecies]);

  const showFrequent = frequentSpecies.length > 0 && !searchQuery.trim();
  const isDisabled = selectedDetectionId === null;

  // Build flat visible list for hotkey numbering
  const flatVisible = useMemo(() => {
    const result: Species[] = [];
    if (showFrequent) {
      result.push(...frequentSpecies);
    }
    for (const [, items] of grouped) {
      result.push(...items);
    }
    // Deduplicate (recent species may also appear in grouped)
    const seen = new Set<string>();
    return result.filter((sp) => {
      if (seen.has(sp.scientificName)) return false;
      seen.add(sp.scientificName);
      return true;
    });
  }, [showFrequent, frequentSpecies, grouped]);

  // Hotkey index map: scientificName → 1-based hotkey number (1-10)
  const hotkeyMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < Math.min(10, flatVisible.length); i++) {
      map.set(flatVisible[i].scientificName, i + 1);
    }
    return map;
  }, [flatVisible]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-2 pb-2 border-b">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Especies</h3>
          <button
            type="button"
            onClick={onCycleDisplay}
            className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border transition-colors"
            title="Cambiar formato de nombre"
          >
            {DISPLAY_LABELS[nameDisplay]}
          </button>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            placeholder="Buscar especie..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-8 pl-7 text-sm"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-1 py-1">
        {isDisabled && (
          <p className="text-xs text-muted-foreground text-center py-3 px-2">
            Seleccione una detección para asignar especie
          </p>
        )}

        {showFrequent && (
          <div className="mb-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1">
              Frecuentes
            </p>
            {frequentSpecies.map((sp) => (
              <SpeciesRow
                key={`recent-${sp.id}`}
                species={sp}
                hotkeyNum={hotkeyMap.get(sp.scientificName) ?? null}
                isActive={currentSpecies === sp.scientificName}
                isDisabled={isDisabled}
                onSelect={onSelectSpecies}
                nameDisplay={nameDisplay}
              />
            ))}
          </div>
        )}

        {grouped.map(([type, items], index) => (
          <div key={type} className={`mb-1${index > 0 || showFrequent ? " border-t border-border mt-2 pt-2" : ""}`}>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1">
              {TYPE_LABELS[type] || type}
            </p>
            {items.map((sp) => (
              <SpeciesRow
                key={sp.id}
                species={sp}
                hotkeyNum={hotkeyMap.get(sp.scientificName) ?? null}
                isActive={currentSpecies === sp.scientificName}
                isDisabled={isDisabled}
                onSelect={onSelectSpecies}
                nameDisplay={nameDisplay}
              />
            ))}
          </div>
        ))}

        {filteredSpecies.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No se encontraron especies
          </p>
        )}
      </div>

      {onAddSpecies && (
        <div className="px-2 py-2 border-t">
          <button
            type="button"
            onClick={onAddSpecies}
            className="w-full text-xs text-muted-foreground hover:text-foreground py-1 rounded hover:bg-accent transition-colors"
          >
            + Agregar especie
          </button>
        </div>
      )}
    </div>
  );
}

function SpeciesRow({
  species: sp,
  hotkeyNum,
  isActive,
  isDisabled,
  onSelect,
  nameDisplay,
}: {
  species: Species;
  hotkeyNum: number | null;
  isActive: boolean;
  isDisabled: boolean;
  onSelect?: (scientificName: string) => void;
  nameDisplay: NameDisplay;
}) {
  const title = `${sp.scientificName} — ${sp.commonName}${sp.spanishName ? ` — ${sp.spanishName}` : ""}`;
  const readOnly = !onSelect;

  return (
    <button
      type="button"
      disabled={isDisabled || readOnly}
      onClick={() => onSelect?.(sp.scientificName)}
      title={title}
      className={`w-full text-left px-2 py-1 rounded text-sm flex items-center gap-1.5 min-w-0 transition-colors ${
        isActive
          ? "bg-primary/10 text-primary"
          : isDisabled || readOnly
            ? "opacity-50 cursor-not-allowed"
            : "hover:bg-accent cursor-pointer"
      }`}
    >
      {hotkeyNum !== null && (
        <Badge
          variant="outline"
          className="text-[10px] font-mono w-4 h-4 p-0 flex items-center justify-center flex-shrink-0"
        >
          {hotkeyNum === 10 ? "0" : hotkeyNum}
        </Badge>
      )}
      {isActive && <Check className="h-3 w-3 flex-shrink-0 text-primary" />}
      {nameDisplay === "common" && (
        <span className="truncate text-xs">{sp.commonName || sp.scientificName}</span>
      )}
      {nameDisplay === "spanish" && (
        <span className="truncate text-xs">{sp.spanishName || sp.commonName || sp.scientificName}</span>
      )}
      {nameDisplay === "scientific" && (
        <span className="italic truncate text-xs">{sp.scientificName}</span>
      )}
    </button>
  );
}

/** Returns the flat visible species list for hotkey mapping from outside the component */
export function getVisibleSpecies(
  speciesList: Species[],
  frequentSpecies: Species[],
  searchQuery: string
): Species[] {
  const filtered = searchQuery.trim()
    ? speciesList.filter((sp) => {
        const q = searchQuery.toLowerCase();
        return (
          sp.scientificName.toLowerCase().includes(q) ||
          sp.commonName.toLowerCase().includes(q) ||
          (sp.spanishName && sp.spanishName.toLowerCase().includes(q))
        );
      })
    : speciesList;

  const grouped = groupByType(filtered);
  const showFrequent = frequentSpecies.length > 0 && !searchQuery.trim();

  const result: Species[] = [];
  if (showFrequent) {
    result.push(...frequentSpecies);
  }
  for (const [, items] of grouped) {
    result.push(...items);
  }

  const seen = new Set<string>();
  return result.filter((sp) => {
    if (seen.has(sp.scientificName)) return false;
    seen.add(sp.scientificName);
    return true;
  });
}
