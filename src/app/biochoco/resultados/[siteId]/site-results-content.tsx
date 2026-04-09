"use client";

import type { SiteDetail } from "../types";
import { SpeciesCards } from "./species-cards";
import { HabitatSection } from "./habitat-section";
import { TemperatureOverlay } from "./temperature-overlay";
import { Separator } from "@/components/ui/separator";
import { Camera } from "lucide-react";

interface SiteResultsContentProps {
  data: SiteDetail;
  /**
   * Resolves a camera trap image ID to a URL. The internal page hands
   * back the authenticated `/api/ct-images/...` URL; the public landowner
   * share view hands back the token-gated `/api/public/site-images/...`
   * URL. Children remain ignorant of the variant.
   */
  resolveImageUrl: (imageId: number, size: "thumb" | "large") => string;
  /**
   * Optional builder for per-species links. The public view points each
   * species card at its own gallery sub-route; internal omits.
   */
  speciesHref: ((speciesName: string) => string) | null;
  /**
   * Toggles features that need authenticated context:
   * - "internal" shows habitat field photos (served by /api/odk/photos
   *   which requires a session), the recharts temperature overlay (heavy
   *   client JS), and per-deployment links to /biochoco/ibutton/[id].
   * - "public"  hides all three so the page works for unauthenticated
   *   landowners on a slow phone with JS disabled.
   *
   * Section ORDER is the same in both variants: Fauna → Hábitat →
   * Temperatura. Audio is omitted everywhere — no annotations yet.
   */
  variant: "internal" | "public";
}

export function SiteResultsContent({
  data,
  resolveImageUrl,
  speciesHref,
  variant,
}: SiteResultsContentProps) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
          <Camera className="h-5 w-5" />
          Fauna
        </h2>
        <SpeciesCards
          species={data.species}
          totalDetections={data.species.reduce(
            (sum, s) => sum + s.detectionCount,
            0
          )}
          resolveImageUrl={resolveImageUrl}
          speciesHref={speciesHref}
        />
      </section>

      <Separator />

      <HabitatSection
        habitat={data.habitat}
        totalCount={data.habitatAssessmentCount}
        showPhotos={variant === "internal"}
      />

      <Separator />

      <TemperatureOverlay
        temperature={data.temperature}
        temperatureStats={data.temperatureStats}
        showChart={variant === "internal"}
        showDeploymentLinks={variant === "internal"}
      />
    </div>
  );
}
