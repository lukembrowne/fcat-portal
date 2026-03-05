"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { Species } from "@/db/schema";

const TYPE_LABELS: Record<string, string> = {
  mammal: "Mamíferos",
  bird: "Aves",
  system: "Sistema",
  reptile: "Reptiles",
  amphibian: "Anfibios",
  insect: "Insectos",
};

const TYPE_ORDER = ["mammal", "bird", "reptile", "amphibian", "insect", "system"];

const RANK_BADGES: Record<string, { short: string; className: string }> = {
  species: { short: "sp.", className: "bg-green-100 text-green-800" },
  genus: { short: "gen.", className: "bg-blue-100 text-blue-800" },
  family: { short: "fam.", className: "bg-purple-100 text-purple-800" },
  order: { short: "ord.", className: "bg-orange-100 text-orange-800" },
  class: { short: "cl.", className: "bg-gray-100 text-gray-800" },
};

interface SpeciesComboboxProps {
  species: Species[];
  frequentSpecies?: Species[];
  onSelect: (scientificName: string) => void;
  disabled?: boolean;
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

export function SpeciesCombobox({
  species: speciesList,
  frequentSpecies = [],
  onSelect,
  disabled,
}: SpeciesComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const grouped = groupByType(speciesList);

  const handleSelect = (scientificName: string) => {
    setOpen(false); // Optimistic close
    setSearch("");
    onSelect(scientificName);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 text-xs justify-start"
          disabled={disabled}
        >
          Seleccionar especie...
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command loop shouldFilter={true}>
          <CommandInput
            placeholder="Buscar por nombre..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No se encontraron especies.</CommandEmpty>

            {frequentSpecies.length > 0 && !search && (
              <CommandGroup heading="Frecuentes">
                {frequentSpecies.map((sp) => (
                  <SpeciesItem
                    key={`recent-${sp.id}`}
                    species={sp}
                    valuePrefix="recent-"
                    onSelect={handleSelect}
                  />
                ))}
              </CommandGroup>
            )}

            {grouped.map(([type, items]) => (
              <CommandGroup key={type} heading={TYPE_LABELS[type] || type}>
                {items.map((sp) => (
                  <SpeciesItem
                    key={sp.id}
                    species={sp}
                    onSelect={handleSelect}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SpeciesItem({
  species: sp,
  valuePrefix = "",
  onSelect,
}: {
  species: Species;
  valuePrefix?: string;
  onSelect: (scientificName: string) => void;
}) {
  const rank = RANK_BADGES[sp.taxonomicRank] || RANK_BADGES.species;

  return (
    <CommandItem
      value={`${valuePrefix}${sp.scientificName}`}
      keywords={[sp.commonName, sp.spanishName ?? ""]}
      onSelect={() => onSelect(sp.scientificName)}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="italic truncate text-sm">{sp.scientificName}</span>
        <Badge variant="outline" className={`text-[10px] px-1 py-0 flex-shrink-0 ${rank.className}`}>
          {rank.short}
        </Badge>
      </div>
      <span className="text-xs text-muted-foreground truncate ml-auto pl-2">
        {sp.commonName}
      </span>
    </CommandItem>
  );
}
