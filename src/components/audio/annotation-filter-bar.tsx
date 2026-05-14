"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfidenceThresholdSlider } from "./confidence-threshold-slider";

/**
 * Filter bar for the annotation page. Combines the confidence-threshold slider
 * with a "Mostrar todas las detecciones" toggle that bypasses the filter when
 * an annotator needs to validate sub-threshold or rejected detections.
 *
 * Reads `?showAll=1` from the URL and reflects it as a toggle button. Toggling
 * updates the URL (push, not replace, so back-button restores filtered view).
 */
export function AnnotationFilterBar({ showAll }: { showAll: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const toggleShowAll = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (showAll) {
      params.delete("showAll");
    } else {
      params.set("showAll", "1");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams, showAll]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <ConfidenceThresholdSlider variant="compact" disabled={showAll} />
      <Button
        type="button"
        variant={showAll ? "default" : "outline"}
        size="sm"
        onClick={toggleShowAll}
        aria-pressed={showAll}
      >
        {showAll ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        {showAll ? "Ocultar < umbral" : "Mostrar todas las detecciones"}
      </Button>
    </div>
  );
}
