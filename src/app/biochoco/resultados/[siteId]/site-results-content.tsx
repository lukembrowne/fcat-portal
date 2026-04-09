"use client";

import type { SiteDetail } from "../types";
import { SpeciesCards } from "./species-cards";
import { HabitatSection } from "./habitat-section";
import { TemperatureOverlay } from "./temperature-overlay";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import { Camera, Volume2 } from "lucide-react";

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
   * Controls section ORDER and which optional elements appear.
   * - "internal": Hábitat (with photos) → Fauna → Temperatura (chart + links) → Audio placeholder
   * - "public":  Fauna → Hábitat (no photos) → Temperatura (stats only)
   */
  variant: "internal" | "public";
}

export function SiteResultsContent({
  data,
  resolveImageUrl,
  speciesHref,
  variant,
}: SiteResultsContentProps) {
  const fauna = (
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
  );

  const habitat = (
    <HabitatSection
      habitat={data.habitat}
      totalCount={data.habitatAssessmentCount}
      showPhotos={variant === "internal"}
    />
  );

  const temperature = (
    <TemperatureOverlay
      temperature={data.temperature}
      temperatureStats={data.temperatureStats}
      showChart={variant === "internal"}
      showDeploymentLinks={variant === "internal"}
    />
  );

  if (variant === "public") {
    return (
      <div className="space-y-6">
        {fauna}
        <Separator />
        {habitat}
        <Separator />
        {temperature}
      </div>
    );
  }

  // Internal variant — preserves the original section order so the
  // existing /biochoco/resultados/[siteId] page is unchanged.
  return (
    <div className="space-y-6">
      {habitat}
      <Separator />
      {fauna}
      <Separator />
      {temperature}
      <Separator />

      {/* Audio placeholder — internal only, until annotations exist */}
      <section>
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
          <Volume2 className="h-5 w-5" />
          Audio
        </h2>
        <Card className="border-dashed">
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground font-medium">Próximamente</p>
            <p className="text-sm text-muted-foreground mt-1">
              Los datos de monitoreo acústico se integrarán en una futura
              actualización.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
