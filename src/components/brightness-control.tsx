"use client";

import { useState } from "react";
import { Sun } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  brightnessFilter,
  DEFAULT_BRIGHTNESS,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
} from "@/lib/brightness-filter";

export {
  brightnessFilter,
  DEFAULT_BRIGHTNESS,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
};

interface BrightnessControlProps {
  value: number;
  onChange: (v: number) => void;
  className?: string;
}

export function BrightnessControl({
  value,
  onChange,
  className,
}: BrightnessControlProps) {
  const [open, setOpen] = useState(false);
  const isActive = value !== DEFAULT_BRIGHTNESS;
  const percent = Math.round(value * 100);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "p-1.5 rounded bg-black/60 text-white hover:bg-black/80 transition-colors",
            isActive && "ring-2 ring-amber-400",
            className,
          )}
          title={`Brillo${isActive ? ` (${percent}%)` : ""} — \\ para ciclar`}
          aria-label="Ajustar brillo de la imagen"
        >
          <Sun className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-56 p-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">Brillo</span>
            <span className="font-mono text-muted-foreground">{percent}%</span>
          </div>
          <input
            type="range"
            min={MIN_BRIGHTNESS * 100}
            max={MAX_BRIGHTNESS * 100}
            step={5}
            value={percent}
            onChange={(e) => onChange(Number(e.target.value) / 100)}
            className="w-full accent-amber-500"
            aria-label="Brillo de la imagen"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full h-7 text-xs"
            onClick={() => onChange(DEFAULT_BRIGHTNESS)}
            disabled={!isActive}
          >
            Restablecer
          </Button>
          <p className="text-[10px] text-muted-foreground leading-tight">
            Atajo: <kbd className="px-1 py-0.5 bg-background border rounded font-mono text-[10px]">\</kbd> cicla 100% → 70% → 50%
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
