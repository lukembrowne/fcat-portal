"use client";

import { RotateCcw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Static configuration for one image-adjustment slider. Kept as plain data
 * rather than baked into JSX so the wiring — ranges, Spanish labels, aria
 * strings — is unit-testable in the node test environment, which has no
 * component-render harness. Mirrors the `buildAudioNav` pattern in
 * `sidebar-nav.tsx`.
 *
 * `min`, `max`, and `defaultValue` are CSS filter multipliers (1.0 = neutral).
 * `stepPercent` is in percentage points, matching the range input's scale.
 */
export interface ImageAdjustPreset {
  label: string;
  min: number;
  max: number;
  defaultValue: number;
  stepPercent: number;
  /** Used for both `title` and `aria-label` on the reset button. */
  resetLabel: string;
  /** `aria-label` on the range input. */
  sliderLabel: string;
  /** Optional `title` on the range input — carries a keyboard-shortcut hint
   *  for the controls that have one. */
  sliderTitle?: string;
}

interface ImageAdjustControlProps {
  preset: ImageAdjustPreset;
  /**
   * Both call sites are Client Components, so passing the icon component
   * directly is safe. This would break if the sidebar ever became a Server
   * Component — React components cannot cross that boundary as props. Pass a
   * string id and resolve it on the client if that day comes.
   */
  icon: LucideIcon;
  value: number;
  onChange: (v: number) => void;
  className?: string;
}

export function ImageAdjustControl({
  preset,
  icon: Icon,
  value,
  onChange,
  className,
}: ImageAdjustControlProps) {
  const isActive = value !== preset.defaultValue;
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
          <Icon
            className={cn(
              "size-3.5",
              isActive ? "text-amber-600" : "text-muted-foreground",
            )}
          />
          <span>{preset.label}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {percent}%
          </span>
          <button
            type="button"
            onClick={() => onChange(preset.defaultValue)}
            disabled={!isActive}
            title={preset.resetLabel}
            aria-label={preset.resetLabel}
            className="size-5 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            <RotateCcw className="size-3" />
          </button>
        </div>
      </div>
      <input
        type="range"
        min={preset.min * 100}
        max={preset.max * 100}
        step={preset.stepPercent}
        value={percent}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="w-full accent-amber-500"
        aria-label={preset.sliderLabel}
        title={preset.sliderTitle}
      />
    </div>
  );
}
