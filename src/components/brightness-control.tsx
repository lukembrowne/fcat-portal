"use client";

import { Sun } from "lucide-react";
import {
  ImageAdjustControl,
  type ImageAdjustPreset,
} from "@/components/image-adjust-control";
import {
  DEFAULT_BRIGHTNESS,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
} from "@/lib/image-filter";

export const BRIGHTNESS_PRESET: ImageAdjustPreset = {
  label: "Brillo",
  min: MIN_BRIGHTNESS,
  max: MAX_BRIGHTNESS,
  defaultValue: DEFAULT_BRIGHTNESS,
  stepPercent: 5,
  resetLabel: "Restablecer brillo",
  sliderLabel: "Brillo de la imagen",
  sliderTitle: "Atajo: \\ cicla 100% → 70% → 50%",
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
  return (
    <ImageAdjustControl
      preset={BRIGHTNESS_PRESET}
      icon={Sun}
      value={value}
      onChange={onChange}
      className={className}
    />
  );
}
