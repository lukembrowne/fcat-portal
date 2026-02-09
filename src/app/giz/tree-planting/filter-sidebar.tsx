"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { TreeRecord, TreeFilterState } from "@/lib/odk-types";

interface FilterSidebarProps {
  trees: TreeRecord[];
  filters: TreeFilterState;
  onFilterChange: (filters: TreeFilterState) => void;
  filteredCount: number;
}

export function FilterSidebar({
  trees,
  filters,
  onFilterChange,
  filteredCount,
}: FilterSidebarProps) {
  const farms = useMemo(() => [...new Set(trees.map((t) => t.farm).filter(Boolean))].sort(), [trees]);
  const species = useMemo(() => [...new Set(trees.map((t) => t.species).filter(Boolean))].sort(), [trees]);
  const workers = useMemo(() => [...new Set(trees.map((t) => t.worker).filter(Boolean))].sort(), [trees]);
  const survivals = useMemo(() => [...new Set(trees.map((t) => t.survival).filter(Boolean))].sort(), [trees]);

  function update(key: keyof TreeFilterState, value: string) {
    onFilterChange({ ...filters, [key]: value });
  }

  function reset() {
    onFilterChange({
      farm: "",
      species: "",
      extensionista: "",
      survival: "",
      dateFrom: "",
      dateTo: "",
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Filtros</h3>
        <Button variant="ghost" size="sm" onClick={reset}>
          Limpiar
        </Button>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Finca</Label>
          <Select
            value={filters.farm || "all"}
            onValueChange={(v) => update("farm", v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {farms.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Especie</Label>
          <Select
            value={filters.species || "all"}
            onValueChange={(v) => update("species", v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {species.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Extensionista</Label>
          <Select
            value={filters.extensionista || "all"}
            onValueChange={(v) => update("extensionista", v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {workers.map((w) => (
                <SelectItem key={w} value={w}>
                  {w}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Supervivencia</Label>
          <Select
            value={filters.survival || "all"}
            onValueChange={(v) => update("survival", v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {survivals.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Separator />

        <div className="space-y-1.5">
          <Label className="text-xs">Fecha desde</Label>
          <input
            type="date"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
            value={filters.dateFrom}
            onChange={(e) => update("dateFrom", e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Fecha hasta</Label>
          <input
            type="date"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
            value={filters.dateTo}
            onChange={(e) => update("dateTo", e.target.value)}
          />
        </div>
      </div>

      <Separator />

      <p className="text-xs text-muted-foreground">
        Mostrando {filteredCount} de {trees.length} registros
      </p>
    </div>
  );
}
