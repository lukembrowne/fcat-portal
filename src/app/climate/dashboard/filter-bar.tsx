"use client";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ClimateResolution } from "@/db/schema";
import type { AggregationLevel } from "./actions";

export type DateSelection =
  | { type: "all" }
  | { type: "year"; year: number }
  | { type: "custom"; start: string; end: string };

interface FilterBarProps {
  dateSelection: DateSelection;
  resolution: ClimateResolution;
  aggregation: AggregationLevel;
  availableYears: number[];
  onDateSelectionChange: (sel: DateSelection) => void;
  onResolutionChange: (res: ClimateResolution) => void;
  onAggregationChange: (agg: AggregationLevel) => void;
  aggregationNote: string | null;
}

export function getDateRange(sel: DateSelection): { start: string; end: string } {
  switch (sel.type) {
    case "all":
      return {
        start: "2021-01-01 00:00:00",
        end: new Date().toISOString().slice(0, 19).replace("T", " "),
      };
    case "year":
      return {
        start: `${sel.year}-01-01 00:00:00`,
        end: `${sel.year}-12-31 23:59:59`,
      };
    case "custom":
      return {
        start: `${sel.start} 00:00:00`,
        end: `${sel.end} 23:59:59`,
      };
  }
}

const AGG_LABELS: Record<AggregationLevel, string> = {
  yearly: "Anual",
  monthly: "Mensual",
  daily: "Diario",
  raw: "Sin agregar",
};

export function FilterBar({
  dateSelection,
  resolution,
  aggregation,
  availableYears,
  onDateSelectionChange,
  onResolutionChange,
  onAggregationChange,
  aggregationNote,
}: FilterBarProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* Date selection: Todo + year buttons */}
        <div className="flex items-center gap-1">
          <span className="text-sm text-muted-foreground mr-1">Período:</span>
          <Button
            variant={dateSelection.type === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => onDateSelectionChange({ type: "all" })}
          >
            Todo
          </Button>
          {availableYears.map((year) => (
            <Button
              key={year}
              variant={
                dateSelection.type === "year" && dateSelection.year === year
                  ? "default"
                  : "outline"
              }
              size="sm"
              onClick={() => onDateSelectionChange({ type: "year", year })}
            >
              {year}
            </Button>
          ))}
        </div>

        {/* Resolution selector */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Resolución:</span>
          <Select value={resolution} onValueChange={(v) => onResolutionChange(v as ClimateResolution)}>
            <SelectTrigger className="w-[140px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hourly">Por hora</SelectItem>
              <SelectItem value="15min">Cada 15 min</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Aggregation selector */}
        <div className="flex items-center gap-1">
          <span className="text-sm text-muted-foreground mr-1">Agregación:</span>
          {(["yearly", "monthly", "daily", "raw"] as AggregationLevel[]).map((agg) => (
            <Button
              key={agg}
              variant={aggregation === agg ? "default" : "outline"}
              size="sm"
              onClick={() => onAggregationChange(agg)}
            >
              {AGG_LABELS[agg]}
            </Button>
          ))}
        </div>

        {aggregationNote && (
          <span className="text-xs text-muted-foreground italic">
            {aggregationNote}
          </span>
        )}
      </div>

      {/* Custom date range row */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Rango personalizado:</span>
        <input
          type="date"
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={dateSelection.type === "custom" ? dateSelection.start : ""}
          onChange={(e) => {
            const start = e.target.value;
            if (!start) return;
            const currentEnd =
              dateSelection.type === "custom"
                ? dateSelection.end
                : new Date().toISOString().slice(0, 10);
            onDateSelectionChange({ type: "custom", start, end: currentEnd });
          }}
        />
        <span className="text-sm text-muted-foreground">a</span>
        <input
          type="date"
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={dateSelection.type === "custom" ? dateSelection.end : ""}
          onChange={(e) => {
            const end = e.target.value;
            if (!end) return;
            const currentStart =
              dateSelection.type === "custom"
                ? dateSelection.start
                : "2021-01-01";
            onDateSelectionChange({ type: "custom", start: currentStart, end });
          }}
        />
        {dateSelection.type === "custom" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDateSelectionChange({ type: "all" })}
          >
            Limpiar
          </Button>
        )}
      </div>
    </div>
  );
}
