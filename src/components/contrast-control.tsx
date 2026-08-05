"use client";

import { Contrast } from "lucide-react";
import {
  ImageAdjustControl,
  type ImageAdjustPreset,
} from "@/components/image-adjust-control";
import {
  DEFAULT_CONTRAST,
  MAX_CONTRAST,
  MIN_CONTRAST,
} from "@/lib/image-filter";

/** Deliberately asymmetric around 1.0, unlike brightness: the direction that
 *  helps on flat or hazy frames is up, so the headroom above neutral is wider
 *  than below. No `sliderTitle` — contrast has no keyboard shortcut. */
export const CONTRAST_PRESET: ImageAdjustPreset = {
  label: "Contraste",
  min: MIN_CONTRAST,
  max: MAX_CONTRAST,
  defaultValue: DEFAULT_CONTRAST,
  stepPercent: 5,
  resetLabel: "Restablecer contraste",
  sliderLabel: "Contraste de la imagen",
};

interface ContrastControlProps {
  value: number;
  onChange: (v: number) => void;
  className?: string;
}

export function ContrastControl({
  value,
  onChange,
  className,
}: ContrastControlProps) {
  return (
    <ImageAdjustControl
      preset={CONTRAST_PRESET}
      icon={Contrast}
      value={value}
      onChange={onChange}
      className={className}
    />
  );
}
