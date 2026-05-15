"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BoxPlot, type BoxPlotGroup } from "@/components/box-plot";
import type { AcousticIndicesData } from "@/app/audio/actions";
import {
  DIEL_PERIOD_LABELS,
  type DielPeriod,
} from "@/lib/acoustic-indices";
import {
  parseHabitatsParam,
  parseDielParam,
  habitatMatches,
  type HabitatFilterOption,
} from "./filter-utils";

type IndexKey =
  | "soundscapeSaturation"
  | "acousticComplexityIndex"
  | "frequencyEntropy"
  | "temporalEntropy"
  | "eventsPerSecond";

interface IndexDescriptor {
  key: IndexKey;
  title: string;
  description: string;
  direction: "up" | "down" | "neutral";
  unitLabel?: string;
}

const INDEX_DESCRIPTORS: IndexDescriptor[] = [
  {
    key: "soundscapeSaturation",
    title: "Saturación del paisaje sonoro",
    description:
      "Proporción del espectro de frecuencias ocupada por sonido sobre el ruido de fondo. Indica qué tan «lleno» está el paisaje sonoro (Burivalova et al. 2018).",
    direction: "up",
    unitLabel: "proporción (0–1)",
  },
  {
    key: "acousticComplexityIndex",
    title: "Índice de complejidad acústica (ACI)",
    description:
      "Variabilidad rápida de amplitud dentro de cada banda de frecuencia (Pieretti et al. 2011).",
    direction: "down",
    unitLabel: "ACI",
  },
  {
    key: "frequencyEntropy",
    title: "Entropía de frecuencia",
    description:
      "Qué tan uniformemente se distribuye la energía a lo largo del espectro.",
    direction: "up",
    unitLabel: "Hf (0–1)",
  },
  {
    key: "temporalEntropy",
    title: "Entropía temporal",
    description:
      "Qué tan uniformemente se distribuye la energía en el tiempo.",
    direction: "neutral",
    unitLabel: "Ht (0–1)",
  },
  {
    key: "eventsPerSecond",
    title: "Eventos por segundo",
    description:
      "Conteo de eventos acústicos discretos por unidad de tiempo (Towsey 2018).",
    direction: "down",
    unitLabel: "eventos/s",
  },
];

const DIRECTION_LABELS: Record<"up" | "down" | "neutral", string> = {
  up: "Se espera que aumente hacia bosque maduro (Müller et al. 2023).",
  down: "Se espera que disminuya hacia bosque maduro (Müller et al. 2023).",
  neutral:
    "Señal débil en bosques tropicales — interprete con cautela (Müller et al. 2023).",
};

interface AcousticIndicesSectionProps {
  data: AcousticIndicesData;
  habitatOptions: HabitatFilterOption[];
  availableDielPeriods: DielPeriod[];
}

export function AcousticIndicesSection({
  data,
  habitatOptions,
  availableDielPeriods,
}: AcousticIndicesSectionProps) {
  const params = useSearchParams();
  const selectedHabitats = useMemo(
    () =>
      parseHabitatsParam(
        params.get("h_habitats") ?? undefined,
        habitatOptions,
      ),
    [params, habitatOptions],
  );
  const selectedDiel = parseDielParam(
    params.get("h_diel") ?? undefined,
    availableDielPeriods,
  );

  const filteredGroups = useMemo(() => {
    return data.groups.filter(
      (g) =>
        g.dielPeriod === selectedDiel &&
        habitatMatches(g.habitatKey, selectedHabitats),
    );
  }, [data.groups, selectedDiel, selectedHabitats]);

  if (data.groups.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Índices acústicos</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No hay índices acústicos calculados aún. Calcula los índices desde
            la sección de Audio.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Índices acústicos · {DIEL_PERIOD_LABELS[selectedDiel]}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {filteredGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay datos para los hábitats y periodo seleccionados.
          </p>
        ) : (
          <div className="space-y-4">
            {INDEX_DESCRIPTORS.map((descriptor) => (
              <BoxPlot
                key={descriptor.key}
                groups={toBoxPlotGroups(filteredGroups, descriptor.key)}
                title={descriptor.title}
                description={descriptor.description}
                expectedDirection={descriptor.direction}
                expectedDirectionLabel={DIRECTION_LABELS[descriptor.direction]}
                unitLabel={descriptor.unitLabel}
                valueLabel={descriptor.title}
                lowCoverageThreshold={4}
                emptyMessage="No hay datos para esta combinación."
                formatValue={(v) => v.toFixed(3)}
                formatTickLabel={formatIndexTick}
              />
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Cada punto representa la mediana de un despliegue. Hábitats con menos
          de 4 despliegues se muestran atenuados para indicar baja cobertura.
        </p>
      </CardContent>
    </Card>
  );
}

function toBoxPlotGroups(
  groups: AcousticIndicesData["groups"],
  indexKey: IndexKey,
): BoxPlotGroup[] {
  return groups
    .map((g) => ({
      key: g.habitatKey,
      label: g.habitatLabel,
      color: g.color,
      points: g.points.map((p) => ({
        id: p.deploymentId,
        value: p[indexKey],
        primaryLabel: p.deploymentName,
        secondaryLabel: p.siteName ?? undefined,
        footnote: `n=${p.nFiles} archivos`,
      })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function formatIndexTick(v: number): string {
  if (Math.abs(v) >= 1000) return v.toExponential(1);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

