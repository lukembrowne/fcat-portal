"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import type { SiteInfo } from "../overview/types";
import { getHabitatName } from "../overview/types";
import type { HabitatAssessment } from "./types";
import { BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_HABITAT } from "@/lib/odk-constants";
import { HabitatMap } from "./habitat-map";
import { HabitatCharts } from "./habitat-charts";
import { HabitatSiteTable } from "./habitat-site-table";
import { PhotoDownloadButton } from "@/components/photo-download-button";

interface HabitatShellProps {
  data: {
    sites: SiteInfo[];
    assessments: HabitatAssessment[];
    assessedSiteIds: string[];
  };
}

const PHOTO_LABELS: Record<string, string> = {
  north: "Norte",
  east: "Este",
  south: "Sur",
  west: "Oeste",
  canopy: "Dosel",
};

function photoUrl(instanceId: string, filename: string) {
  return `/api/odk/photos?projectId=${BIOCHOCO_PROJECT_ID}&formId=${BIOCHOCO_FORM_HABITAT}&id=${encodeURIComponent(instanceId)}&file=${encodeURIComponent(filename)}`;
}

function PhotoDialog({
  assessment,
  open,
  onOpenChange,
}: {
  assessment: HabitatAssessment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!assessment) return null;

  const photos = [
    { key: "north", filename: assessment.photoNorth },
    { key: "east", filename: assessment.photoEast },
    { key: "south", filename: assessment.photoSouth },
    { key: "west", filename: assessment.photoWest },
    { key: "canopy", filename: assessment.photoCanopy },
  ].filter((p) => p.filename);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[90vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {assessment.siteName} — Fotos
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            {getHabitatName(assessment.habitatType)} | {assessment.assessmentDate}
          </p>
        </DialogHeader>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {photos.map((p) => (
            <div key={p.key} className="space-y-1">
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoUrl(assessment.instanceId, p.filename)}
                  alt={PHOTO_LABELS[p.key] ?? p.key}
                  className="w-full h-80 object-cover rounded-md"
                />
                <PhotoDownloadButton
                  photoUrl={photoUrl(assessment.instanceId, p.filename)}
                  filename={p.filename}
                />
              </div>
              <p className="text-xs text-center text-muted-foreground">
                {PHOTO_LABELS[p.key] ?? p.key}
              </p>
            </div>
          ))}
        </div>
        {assessment.habitatNotes && (
          <p className="text-sm text-muted-foreground mt-2">
            <strong>Notas:</strong> {assessment.habitatNotes}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function HabitatShell({ data }: HabitatShellProps) {
  const [selectedAssessment, setSelectedAssessment] =
    useState<HabitatAssessment | null>(null);

  const assessedSet = useMemo(
    () => new Set(data.assessedSiteIds),
    [data.assessedSiteIds]
  );

  const totalSites = data.sites.length;
  const assessedCount = assessedSet.size;
  const pct = totalSites > 0 ? ((assessedCount / totalSites) * 100).toFixed(1) : "0";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Evaluación de Hábitat</h1>
        <p className="text-sm text-muted-foreground">
          Estructura y condición del hábitat en los sitios de monitoreo
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Mapa de Sitios</h2>
        <HabitatMap sites={data.sites} assessedSet={assessedSet} />
        <p className="mt-2 text-sm text-muted-foreground">
          {assessedCount} / {totalSites} sitios evaluados ({pct}%)
        </p>
      </section>

      <Separator />

      <section>
        <h2 className="text-lg font-semibold mb-3">Resumen por Tipo de Hábitat</h2>
        <HabitatCharts assessments={data.assessments} />
      </section>

      <Separator />

      <section>
        <h2 className="text-lg font-semibold mb-3">Detalle por Sitio</h2>
        <HabitatSiteTable
          assessments={data.assessments}
          onViewPhotos={setSelectedAssessment}
        />
      </section>

      <PhotoDialog
        assessment={selectedAssessment}
        open={selectedAssessment !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedAssessment(null);
        }}
      />
    </div>
  );
}
