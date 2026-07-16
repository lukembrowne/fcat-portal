"use client";

import type { SiteDetail, SiteAudioData } from "../types";
import { SpeciesCards } from "./species-cards";
import { HabitatSection } from "./habitat-section";
import { TemperatureOverlay } from "./temperature-overlay";
import { AudioIndicesPanel } from "./audio-indices-panel";
import { AudioSpeciesSection } from "./audio-species-section";
import { Separator } from "@/components/ui/separator";
import { Bird, Camera, Waves } from "lucide-react";

interface SiteResultsContentProps {
  // `site` is not read here; accept both internal (SiteDetail) and the
  // landowner-safe public payload by omitting it from the required shape.
  data: Omit<SiteDetail, "site">;
  /**
   * Audio data (acoustic indices + verified BirdNET species). Null on the
   * public-share variant since audio panels are internal-only in v1.
   */
  audio: SiteAudioData | null;
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
   *   Audio panels (BirdNET species + acoustic indices) render when
   *   audio data is present.
   * - "public"  hides habitat photos, the temperature chart, per-deployment
   *   links, AND all audio panels. Section ORDER otherwise matches.
   *
   * Section order: Fauna → Aves (BirdNET) → Índices acústicos → Hábitat →
   * Temperatura. Audio sections are omitted when the site has no audio.
   */
  variant: "internal" | "public";
  /** Site label woven into per-photo share captions (public view only). */
  shareSiteLabel?: string;
  /**
   * Whether to render the leading "Fauna" species-grid section. Defaults to
   * true. The public landowner page sets this false because the species are
   * already shown in the swipe carousel above.
   */
  showFauna?: boolean;
}

export function SiteResultsContent({
  data,
  audio,
  resolveImageUrl,
  speciesHref,
  variant,
  shareSiteLabel,
  showFauna = true,
}: SiteResultsContentProps) {
  const showAudio =
    variant === "internal" && audio !== null && audio.hasAudio;
  const hasAudioSpecies = showAudio && audio.species.length > 0;
  const hasAudioIndices = showAudio && audio.indices.length > 0;

  return (
    <div className="space-y-6">
      {showFauna && (
        <section>
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
            <Camera className="h-5 w-5" />
            Fauna
          </h2>
          <SpeciesCards
            species={data.species}
            totalDetections={data.species.reduce(
              (sum, s) => sum + s.detectionCount,
              0,
            )}
            resolveImageUrl={resolveImageUrl}
            speciesHref={speciesHref}
            shareSiteLabel={shareSiteLabel}
          />
        </section>
      )}

      {hasAudioSpecies && (
        <>
          <Separator />
          <section>
            <div className="mb-4 flex items-baseline justify-between gap-2">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Bird className="h-5 w-5" />
                Aves (BirdNET)
              </h2>
              <p className="text-xs text-muted-foreground">
                {audio.reviewedDeploymentCount} de{" "}
                {audio.totalAudioDeploymentCount} despliegues revisados
              </p>
            </div>
            <AudioSpeciesSection species={audio.species} />
          </section>
        </>
      )}

      {hasAudioIndices && (
        <>
          <Separator />
          <section>
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
              <Waves className="h-5 w-5" />
              Índices acústicos
            </h2>
            <AudioIndicesPanel groups={audio.indices} />
          </section>
        </>
      )}

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
