"use client";

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
import type { CacaoRecord, CacaoFilterState } from "@/lib/odk-types";

interface FilterSidebarProps {
  records: CacaoRecord[];
  filters: CacaoFilterState;
  onFilterChange: (filters: CacaoFilterState) => void;
  filteredCount: number;
}

export function FilterSidebar({
  records,
  filters,
  onFilterChange,
  filteredCount,
}: FilterSidebarProps) {
  const communities = [...new Set(records.map((r) => r.community).filter(Boolean))].sort();
  const farmCodes = [...new Set(records.map((r) => r.farmCode).filter(Boolean))].sort();
  const fertilizedOptions = [...new Set(records.map((r) => r.fertilized).filter((v): v is string => !!v))].sort();

  function update(key: keyof CacaoFilterState, value: string | number) {
    onFilterChange({ ...filters, [key]: value });
  }

  function reset() {
    onFilterChange({
      community: "",
      farmCode: "",
      fertilized: "",
      survivalMin: 0,
      survivalMax: 100,
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
          <Label className="text-xs">Comunidad</Label>
          <Select
            value={filters.community || "all"}
            onValueChange={(v) => update("community", v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {communities.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Código de Finca</Label>
          <Select
            value={filters.farmCode || "all"}
            onValueChange={(v) => update("farmCode", v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {farmCodes.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Fertilización</Label>
          <Select
            value={filters.fertilized || "all"}
            onValueChange={(v) => update("fertilized", v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {fertilizedOptions.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Separator />

        <div className="space-y-1.5">
          <Label className="text-xs">
            Supervivencia: {filters.survivalMin}% – {filters.survivalMax}%
          </Label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={100}
              value={filters.survivalMin}
              onChange={(e) => update("survivalMin", Number(e.target.value))}
              className="w-full"
            />
            <input
              type="range"
              min={0}
              max={100}
              value={filters.survivalMax}
              onChange={(e) => update("survivalMax", Number(e.target.value))}
              className="w-full"
            />
          </div>
        </div>
      </div>

      <Separator />

      <p className="text-xs text-muted-foreground">
        Mostrando {filteredCount} de {records.length} registros
      </p>
    </div>
  );
}
