"use client";

import { useMemo, useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Check, Search } from "lucide-react";
import type { Species } from "@/db/schema";

type NameDisplay = "common" | "scientific" | "both";
const DISPLAY_KEY = "species-name-display";

function getStoredDisplay(): NameDisplay {
  if (typeof window === "undefined") return "common";
  const stored = localStorage.getItem(DISPLAY_KEY);
  if (stored === "common" || stored === "scientific" || stored === "both") return stored;
  return "common";
}

const DISPLAY_LABELS: Record<NameDisplay, string> = {
  common: "Común",
  scientific: "Científico",
  both: "Ambos",
};

const DISPLAY_CYCLE: NameDisplay[] = ["common", "scientific", "both"];

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
  recentSpecies: Species[];
  selectedDetectionId: number | null;
  currentSpecies: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectSpecies: (scientificName: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
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
  recentSpecies,
  selectedDetectionId,
  currentSpecies,
  searchQuery,
  onSearchChange,
  onSelectSpecies,
  searchInputRef,
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

  const showRecent = recentSpecies.length > 0 && !searchQuery.trim();
  const isDisabled = selectedDetectionId === null;

  // Build flat visible list for hotkey numbering
  const flatVisible = useMemo(() => {
    const result: Species[] = [];
    if (showRecent) {
      result.push(...recentSpecies);
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
  }, [showRecent, recentSpecies, grouped]);

  // Hotkey index map: scientificName → 1-based hotkey number (1-10)
  const hotkeyMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < Math.min(10, flatVisible.length); i++) {
      map.set(flatVisible[i].scientificName, i + 1);
    }
    return map;
  }, [flatVisible]);

  const [nameDisplay, setNameDisplay] = useState<NameDisplay>(getStoredDisplay);

  const cycleDisplay = useCallback(() => {
    setNameDisplay((prev) => {
      const idx = DISPLAY_CYCLE.indexOf(prev);
      const next = DISPLAY_CYCLE[(idx + 1) % DISPLAY_CYCLE.length];
      localStorage.setItem(DISPLAY_KEY, next);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="px-2 pb-2 border-b">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Especies</h3>
          <button
            type="button"
            onClick={cycleDisplay}
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

        {showRecent && (
          <div className="mb-1">
            <p className="text-xs font-medium text-muted-foreground px-2 py-1">
              Recientes
            </p>
            {recentSpecies.map((sp) => (
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

        {grouped.map(([type, items]) => (
          <div key={type} className="mb-1">
            <p className="text-xs font-medium text-muted-foreground px-2 py-1">
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
  onSelect: (scientificName: string) => void;
  nameDisplay: NameDisplay;
}) {
  const title = `${sp.scientificName} — ${sp.commonName}`;

  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={() => onSelect(sp.scientificName)}
      title={title}
      className={`w-full text-left px-2 py-1 rounded text-sm flex items-center gap-1.5 min-w-0 transition-colors ${
        isActive
          ? "bg-primary/10 text-primary"
          : isDisabled
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
      {nameDisplay === "scientific" && (
        <span className="italic truncate text-xs">{sp.scientificName}</span>
      )}
      {nameDisplay === "both" && (
        <>
          <span className="italic truncate text-xs">{sp.scientificName}</span>
          <span className="text-[10px] text-muted-foreground truncate ml-auto pl-1">
            {sp.commonName}
          </span>
        </>
      )}
    </button>
  );
}

/** Returns the flat visible species list for hotkey mapping from outside the component */
export function getVisibleSpecies(
  speciesList: Species[],
  recentSpecies: Species[],
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
  const showRecent = recentSpecies.length > 0 && !searchQuery.trim();

  const result: Species[] = [];
  if (showRecent) {
    result.push(...recentSpecies);
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
