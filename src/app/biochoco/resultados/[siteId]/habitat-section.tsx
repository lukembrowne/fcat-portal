"use client";

import Image from "next/image";
import type { HabitatAssessment } from "../../habitat/types";
import {
  UNDERSTORY_LABELS,
  SLOPE_LABELS,
  DISTURBANCE_LABELS,
  HEIGHT_CLASS_LABELS,
} from "../../habitat/types";
import { Card, CardContent } from "@/components/ui/card";
import { TreePine } from "lucide-react";
import { BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_HABITAT } from "@/lib/odk-constants";

interface HabitatSectionProps {
  habitat: HabitatAssessment | null;
  totalCount: number;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-muted rounded-lg px-4 py-3">
      <p className="text-lg font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function HabitatPhoto({
  label,
  filename,
  instanceId,
}: {
  label: string;
  filename: string;
  instanceId: string;
}) {
  if (!filename) {
    return (
      <div className="space-y-1">
        <div className="h-32 bg-muted rounded-lg flex items-center justify-center">
          <p className="text-xs text-muted-foreground">Sin foto</p>
        </div>
        <p className="text-xs text-center text-muted-foreground">{label}</p>
      </div>
    );
  }

  const src = `/api/odk/photos?projectId=${BIOCHOCO_PROJECT_ID}&formId=${BIOCHOCO_FORM_HABITAT}&id=${encodeURIComponent(instanceId)}&file=${encodeURIComponent(filename)}`;

  return (
    <div className="space-y-1">
      <div className="relative h-32 rounded-lg overflow-hidden bg-muted">
        <Image
          src={src}
          alt={label}
          fill
          className="object-cover"
          sizes="(max-width: 640px) 50vw, 20vw"
        />
      </div>
      <p className="text-xs text-center text-muted-foreground">{label}</p>
    </div>
  );
}

export function HabitatSection({ habitat, totalCount }: HabitatSectionProps) {
  return (
    <section>
      <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
        <TreePine className="h-5 w-5" />
        Hábitat
      </h2>

      {!habitat ? (
        <div className="flex items-center justify-center h-[200px] bg-muted rounded-xl">
          <p className="text-muted-foreground">
            No se ha realizado evaluación de hábitat para este sitio.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {totalCount > 1 && (
            <p className="text-sm text-muted-foreground">
              Evaluación más reciente (de {totalCount} total)
            </p>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard
              label="Cobertura del dosel"
              value={`${habitat.canopyCoverPercent}%`}
            />
            <StatCard
              label="Altura del dosel"
              value={HEIGHT_CLASS_LABELS[habitat.canopyHeightClass] ?? (habitat.canopyHeightClass || "—")}
            />
            <StatCard
              label="Árboles (med + grd)"
              value={`${habitat.treesMedium} + ${habitat.treesLarge}`}
            />
            <StatCard
              label="Sotobosque"
              value={
                UNDERSTORY_LABELS[habitat.understoryDensity] ??
                (habitat.understoryDensity || "—")
              }
            />
            <StatCard
              label="Pendiente"
              value={
                SLOPE_LABELS[habitat.slopeCategory] ??
                (habitat.slopeCategory || "—")
              }
            />
            <StatCard
              label="Dist. al borde"
              value={habitat.distanceToEdgeM ? `${habitat.distanceToEdgeM}m` : "—"}
            />
          </div>

          {habitat.disturbanceSigns && habitat.disturbanceSigns !== "none" && (
            <p className="text-sm">
              <strong>Perturbaciones:</strong>{" "}
              {DISTURBANCE_LABELS[habitat.disturbanceSigns] ??
                habitat.disturbanceSigns}
            </p>
          )}

          {/* Directional photos */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <HabitatPhoto
              label="Norte"
              filename={habitat.photoNorth}
              instanceId={habitat.instanceId}
            />
            <HabitatPhoto
              label="Este"
              filename={habitat.photoEast}
              instanceId={habitat.instanceId}
            />
            <HabitatPhoto
              label="Sur"
              filename={habitat.photoSouth}
              instanceId={habitat.instanceId}
            />
            <HabitatPhoto
              label="Oeste"
              filename={habitat.photoWest}
              instanceId={habitat.instanceId}
            />
            <HabitatPhoto
              label="Dosel"
              filename={habitat.photoCanopy}
              instanceId={habitat.instanceId}
            />
          </div>
        </div>
      )}
    </section>
  );
}
