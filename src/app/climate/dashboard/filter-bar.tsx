"use client";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ClimateResolution } from "@/db/schema";

type DatePreset = "30d" | "1y" | "all";

interface FilterBarProps {
  datePreset: DatePreset;
  resolution: ClimateResolution;
  onDatePresetChange: (preset: DatePreset) => void;
  onResolutionChange: (res: ClimateResolution) => void;
  aggregationNote: string | null;
}

export type { DatePreset };

export function getDateRange(preset: DatePreset): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 19).replace("T", " ");

  switch (preset) {
    case "30d": {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      return { start: start.toISOString().slice(0, 19).replace("T", " "), end };
    }
    case "1y": {
      const start = new Date(now);
      start.setFullYear(start.getFullYear() - 1);
      return { start: start.toISOString().slice(0, 19).replace("T", " "), end };
    }
    case "all":
      return { start: "2021-01-01 00:00:00", end };
  }
}

export function FilterBar({
  datePreset,
  resolution,
  onDatePresetChange,
  onResolutionChange,
  aggregationNote,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1">
        <span className="text-sm text-muted-foreground mr-1">Período:</span>
        {(["30d", "1y", "all"] as DatePreset[]).map((preset) => (
          <Button
            key={preset}
            variant={datePreset === preset ? "default" : "outline"}
            size="sm"
            onClick={() => onDatePresetChange(preset)}
          >
            {preset === "30d" ? "30 días" : preset === "1y" ? "1 año" : "Todo"}
          </Button>
        ))}
      </div>

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

      {aggregationNote && (
        <span className="text-xs text-muted-foreground italic">
          {aggregationNote}
        </span>
      )}
    </div>
  );
}
