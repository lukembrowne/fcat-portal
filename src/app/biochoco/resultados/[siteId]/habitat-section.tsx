"use client";

import type { HabitatAssessment } from "../../habitat/types";
import {
  UNDERSTORY_LABELS,
  SLOPE_LABELS,
  DISTURBANCE_LABELS,
  HEIGHT_CLASS_LABELS,
} from "../../habitat/types";
import { TreePine } from "lucide-react";
import { BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_HABITAT } from "@/lib/odk-constants";

interface HabitatSectionProps {
  habitat: HabitatAssessment | null;
  totalCount: number;
  /**
   * If false, hides the directional habitat photos. The photos are
   * served by /api/odk/photos which requires an authenticated session,
   * so they don't load on the public landowner-share view.
   */
  showPhotos?: boolean;
  /**
   * Public landowner-share variant. Hides the slope / distance-to-edge /
   * disturbance metrics (and their explainer bullets), which are less
   * meaningful to a landowner and — for non-forest sites — can read oddly.
   * Internal keeps the full set.
   */
  isPublic?: boolean;
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
        <div className="h-48 bg-muted rounded-lg flex items-center justify-center">
          <p className="text-xs text-muted-foreground">Sin foto</p>
        </div>
        <p className="text-xs text-center text-muted-foreground">{label}</p>
      </div>
    );
  }

  const src = `/api/odk/photos?projectId=${BIOCHOCO_PROJECT_ID}&formId=${BIOCHOCO_FORM_HABITAT}&id=${encodeURIComponent(instanceId)}&file=${encodeURIComponent(filename)}`;

  return (
    <div className="space-y-1">
      <div className="relative h-48 rounded-lg overflow-hidden bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={label}
          className="object-cover w-full h-full"
          loading="lazy"
        />
      </div>
      <p className="text-xs text-center text-muted-foreground">{label}</p>
    </div>
  );
}

export function HabitatSection({
  habitat,
  totalCount,
  showPhotos = true,
  isPublic = false,
}: HabitatSectionProps) {
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

          {/* Plain-language explainer — helps landowners read the stats below */}
          <div className="rounded-lg bg-muted/60 p-4 space-y-2 text-sm">
            <p>
              Estas cifras describen el bosque de su tierra. Nuestro equipo las
              midió en el campo para mostrar qué tan sano y protector es su
              hábitat para la fauna.
            </p>
            <ul className="space-y-1 text-muted-foreground">
              <li>
                <strong>Cobertura y altura del dosel:</strong> qué tan cerrado y
                alto es el techo de árboles. Más cobertura y más altura significan
                un bosque más maduro que da sombra, agua y refugio.
              </li>
              <li>
                <strong>Árboles y sotobosque:</strong> la cantidad de árboles
                grandes y la vegetación baja. Juntos ofrecen comida y escondite a
                los animales.
              </li>
              {!isPublic && (
                <>
                  <li>
                    <strong>Pendiente:</strong> qué tan inclinado es el terreno.
                  </li>
                  <li>
                    <strong>Distancia al borde:</strong> qué tan adentro del
                    bosque está el sitio. Cuanto más lejos del borde, más
                    tranquilo para la vida silvestre.
                  </li>
                  <li>
                    <strong>Perturbaciones:</strong> señales de actividad humana
                    o cambios recientes en el bosque.
                  </li>
                </>
              )}
            </ul>
          </div>

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
            {!isPublic && (
              <>
                <StatCard
                  label="Pendiente"
                  value={
                    SLOPE_LABELS[habitat.slopeCategory] ??
                    (habitat.slopeCategory || "—")
                  }
                />
                <StatCard
                  label="Dist. al borde"
                  value={
                    habitat.distanceToEdgeM
                      ? `${habitat.distanceToEdgeM}m`
                      : "—"
                  }
                />
              </>
            )}
          </div>

          {!isPublic &&
            habitat.disturbanceSigns &&
            habitat.disturbanceSigns !== "none" && (
              <p className="text-sm">
                <strong>Perturbaciones:</strong>{" "}
                {DISTURBANCE_LABELS[habitat.disturbanceSigns] ??
                  habitat.disturbanceSigns}
              </p>
            )}

          {showPhotos && (
            <>
              {/* Directional photos — 3 on top, 2 on bottom */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
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
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-2 gap-3 sm:w-2/3">
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
            </>
          )}
        </div>
      )}
    </section>
  );
}
