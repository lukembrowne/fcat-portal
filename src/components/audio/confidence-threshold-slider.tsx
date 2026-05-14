"use client";

import { useCallback, useEffect, useState } from "react";
import { Info, RotateCcw } from "lucide-react";

import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useConfidenceThreshold } from "@/hooks/use-confidence-threshold";
import {
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  CONFIDENCE_STEP,
  DEFAULT_CONFIDENCE_THRESHOLD,
  canonicalThreshold,
  formatThreshold,
} from "@/lib/audio-confidence";

interface Props {
  className?: string;
  /**
   * When true, the slider is read-only (disabled). Used on the annotation page
   * when the "Mostrar todas" toggle is active.
   */
  disabled?: boolean;
  /**
   * `card` (default) — full-width bordered card with label, slider, numeric
   * input, and max-out hint. Use on standalone filter rows.
   *
   * `compact` — single-row label + slider + value, no border, no numeric
   * input. Use when slotting the control inline with a page header.
   */
  variant?: "card" | "compact";
}

function ThresholdInfoPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Más información sobre el umbral de confianza"
          className="text-muted-foreground hover:text-foreground"
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" className="w-80 text-xs leading-relaxed">
        <p className="mb-2">
          BirdNET asigna a cada detección un puntaje entre 0,10 y 1,00.
          Este puntaje no es una probabilidad: el umbral que separa
          detecciones confiables del ruido varía mucho entre especies.
        </p>
        <p>
          El valor predeterminado de <strong>0,70</strong> filtra el ruido
          más obvio sin descartar especies bien reconocidas como tucanes
          y guacamayos. Bájelo para explorar detecciones marginales o
          súbalo para análisis de alta precisión.
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function ConfidenceThresholdSlider({
  className,
  disabled,
  variant = "card",
}: Props) {
  const [threshold, setThreshold] = useConfidenceThreshold();
  const [inputValue, setInputValue] = useState<string>(formatThreshold(threshold));

  // Keep the numeric input synced with the canonical threshold (back/forward,
  // URL hydration, slider drag).
  useEffect(() => {
    setInputValue(formatThreshold(threshold));
  }, [threshold]);

  const onSliderChange = useCallback(
    (values: number[]) => {
      const next = values[0] ?? DEFAULT_CONFIDENCE_THRESHOLD;
      setThreshold(next);
    },
    [setThreshold]
  );

  const onInputBlur = useCallback(() => {
    const parsed = Number(inputValue);
    if (Number.isFinite(parsed)) {
      const next = canonicalThreshold(parsed);
      setThreshold(next);
      setInputValue(formatThreshold(next));
    } else {
      setInputValue(formatThreshold(threshold));
    }
  }, [inputValue, setThreshold, threshold]);

  const reset = useCallback(() => {
    setThreshold(DEFAULT_CONFIDENCE_THRESHOLD);
  }, [setThreshold]);

  const isDefault = threshold === DEFAULT_CONFIDENCE_THRESHOLD;
  const isMaxedOut = threshold >= 1.0;

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-xs",
          disabled && "opacity-60",
          className
        )}
      >
        <Label
          htmlFor="confidence-threshold-input"
          className="text-muted-foreground whitespace-nowrap"
        >
          Umbral
        </Label>
        <Slider
          min={CONFIDENCE_MIN}
          max={CONFIDENCE_MAX}
          step={CONFIDENCE_STEP}
          value={[threshold]}
          onValueChange={onSliderChange}
          disabled={disabled}
          aria-label="Umbral de confianza"
          aria-valuemin={CONFIDENCE_MIN}
          aria-valuemax={CONFIDENCE_MAX}
          aria-valuenow={threshold}
          className="w-28"
        />
        <span
          className="tabular-nums font-medium text-foreground w-9 text-right"
          aria-live="polite"
        >
          {formatThreshold(threshold)}
        </span>
        <ThresholdInfoPopover />
        {!isDefault && !disabled && (
          <button
            type="button"
            onClick={reset}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Restablecer al predeterminado (0,70)"
            title="Restablecer (0,70)"
          >
            <RotateCcw className="size-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border bg-card px-3 py-2 text-sm",
        className
      )}
    >
      <div className="flex items-center gap-2">
        <Label
          htmlFor="confidence-threshold-input"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Umbral de confianza
        </Label>
        <ThresholdInfoPopover />
        {!isDefault && !disabled && (
          <button
            type="button"
            onClick={reset}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-label="Restablecer al predeterminado (0,70)"
          >
            <RotateCcw className="size-3" />
            0,70
          </button>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Slider
          min={CONFIDENCE_MIN}
          max={CONFIDENCE_MAX}
          step={CONFIDENCE_STEP}
          value={[threshold]}
          onValueChange={onSliderChange}
          disabled={disabled}
          aria-label="Umbral de confianza"
          aria-valuemin={CONFIDENCE_MIN}
          aria-valuemax={CONFIDENCE_MAX}
          aria-valuenow={threshold}
          className="flex-1"
        />
        <Input
          id="confidence-threshold-input"
          type="number"
          inputMode="decimal"
          min={CONFIDENCE_MIN}
          max={CONFIDENCE_MAX}
          step={CONFIDENCE_STEP}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={onInputBlur}
          disabled={disabled}
          className="w-20 tabular-nums"
        />
      </div>
      {isMaxedOut && !disabled && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          A 1,00 casi ninguna detección pasa el filtro. BirdNET rara vez
          emite confianzas exactas de 1,00 — baje el umbral para ver resultados.
        </p>
      )}
    </div>
  );
}
