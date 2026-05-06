"use client";

import { Sun, RotateCcw } from "lucide-react";
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
  const isActive = value !== DEFAULT_BRIGHTNESS;
  const percent = Math.round(value * 100);

  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-1.5 flex flex-col gap-1.5 transition-colors",
        isActive ? "bg-amber-50 border-amber-200" : "border-border",
        className,
      )}
    >
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 font-medium">
          <Sun
            className={cn(
              "size-3.5",
              isActive ? "text-amber-600" : "text-muted-foreground",
            )}
          />
          <span>Brillo</span>
        </div>
        <div className="flex items-center gap-0.5">
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {percent}%
          </span>
          <button
            type="button"
            onClick={() => onChange(DEFAULT_BRIGHTNESS)}
            disabled={!isActive}
            title="Restablecer brillo"
            aria-label="Restablecer brillo"
            className="size-5 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            <RotateCcw className="size-3" />
          </button>
        </div>
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
        title="Atajo: \ cicla 100% → 70% → 50%"
      />
    </div>
  );
}
