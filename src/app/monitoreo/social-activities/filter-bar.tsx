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
import type {
  SocialActivityRecord,
  SocialActivityFilterState,
} from "@/lib/odk-types";
import {
  TIPO_EVENTO_LABELS,
  AREA_DESARROLLO_LABELS,
  LUGAR_EVENTO_LABELS,
  PROYECTO_FCAT_LABELS,
} from "./labels";

interface FilterBarProps {
  activities: SocialActivityRecord[];
  filters: SocialActivityFilterState;
  onFilterChange: (filters: SocialActivityFilterState) => void;
  filteredCount: number;
}

export function FilterBar({
  activities,
  filters,
  onFilterChange,
  filteredCount,
}: FilterBarProps) {
  const tipoEventoOptions = useMemo(
    () =>
      [...new Set(activities.map((a) => a.tipoEvento).filter(Boolean))].sort(),
    [activities]
  );

  const areaDesarrolloOptions = useMemo(
    () =>
      [
        ...new Set(activities.flatMap((a) => a.areasDesarrollo)),
      ].sort(),
    [activities]
  );

  const lugarEventoOptions = useMemo(
    () =>
      [...new Set(activities.map((a) => a.lugarEvento).filter(Boolean))].sort(),
    [activities]
  );

  const proyectoFcatOptions = useMemo(
    () =>
      [
        ...new Set(activities.flatMap((a) => a.proyectosFcat)),
      ].sort(),
    [activities]
  );

  function updateDate(key: "dateFrom" | "dateTo", value: string) {
    onFilterChange({ ...filters, [key]: value });
  }

  function updateSelect(
    key: "tipoEvento" | "areaDesarrollo" | "proyectoFcat" | "lugarEvento",
    value: string
  ) {
    onFilterChange({
      ...filters,
      [key]: value === "all" ? [] : [value],
    });
  }

  function reset() {
    onFilterChange({
      dateFrom: "",
      dateTo: "",
      tipoEvento: [],
      areaDesarrollo: [],
      proyectoFcat: [],
      lugarEvento: [],
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-sm">Filtros</h3>
          <p className="text-xs text-muted-foreground">
            {filteredCount} de {activities.length} actividades
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={reset}>
          Limpiar
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Tipo de Evento</Label>
          <Select
            value={filters.tipoEvento[0] || "all"}
            onValueChange={(v) => updateSelect("tipoEvento", v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {tipoEventoOptions.map((v) => (
                <SelectItem key={v} value={v}>
                  {TIPO_EVENTO_LABELS[v] ?? v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Área de Desarrollo</Label>
          <Select
            value={filters.areaDesarrollo[0] || "all"}
            onValueChange={(v) => updateSelect("areaDesarrollo", v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {areaDesarrolloOptions.map((v) => (
                <SelectItem key={v} value={v}>
                  {AREA_DESARROLLO_LABELS[v] ?? v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Proyecto FCAT</Label>
          <Select
            value={filters.proyectoFcat[0] || "all"}
            onValueChange={(v) => updateSelect("proyectoFcat", v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {proyectoFcatOptions.map((v) => (
                <SelectItem key={v} value={v}>
                  {PROYECTO_FCAT_LABELS[v] ?? v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Lugar</Label>
          <Select
            value={filters.lugarEvento[0] || "all"}
            onValueChange={(v) => updateSelect("lugarEvento", v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {lugarEventoOptions.map((v) => (
                <SelectItem key={v} value={v}>
                  {LUGAR_EVENTO_LABELS[v] ?? v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Fecha desde</Label>
          <input
            type="date"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
            value={filters.dateFrom}
            onChange={(e) => updateDate("dateFrom", e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Fecha hasta</Label>
          <input
            type="date"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
            value={filters.dateTo}
            onChange={(e) => updateDate("dateTo", e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
