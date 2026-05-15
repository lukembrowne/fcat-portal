"use client";

import { useMemo, useState } from "react";
import { BoxPlot, type BoxPlotGroup } from "@/components/box-plot";
import { Button } from "@/components/ui/button";
import {
  DIEL_PERIODS,
  DIEL_PERIOD_LABELS,
  type DielPeriod,
} from "@/lib/acoustic-indices";
import type { AcousticIndicesGroup } from "@/app/audio/actions";

type IndexKey =
  | "soundscapeSaturation"
  | "acousticComplexityIndex"
  | "frequencyEntropy"
  | "temporalEntropy"
  | "eventsPerSecond";

interface IndexDescriptor {
  key: IndexKey;
  title: string;
  unitLabel: string;
}

// Compact set for the per-site drill-down — keep all five but render at
// a denser layout than the habitat tab.
const DESCRIPTORS: IndexDescriptor[] = [
  { key: "soundscapeSaturation", title: "Saturación", unitLabel: "0–1" },
  { key: "acousticComplexityIndex", title: "ACI", unitLabel: "ACI" },
  { key: "frequencyEntropy", title: "Entropía f.", unitLabel: "Hf" },
  { key: "temporalEntropy", title: "Entropía t.", unitLabel: "Ht" },
  { key: "eventsPerSecond", title: "Eventos/s", unitLabel: "eventos/s" },
];

export function AudioIndicesPanel({
  groups,
}: {
  groups: AcousticIndicesGroup[];
}) {
  const availableDiel = useMemo(() => dielPeriodsPresent(groups), [groups]);
  const [selectedDiel, setSelectedDiel] = useState<DielPeriod>(
    availableDiel[0] ?? "dawn",
  );

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hay índices acústicos calculados para los despliegues de este sitio.
      </p>
    );
  }

  const dielGroups = groups.filter((g) => g.dielPeriod === selectedDiel);

  return (
    <div className="space-y-3">
      {availableDiel.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {availableDiel.map((d) => (
            <Button
              key={d}
              type="button"
              size="sm"
              variant={d === selectedDiel ? "default" : "outline"}
              className="h-7 text-xs"
              onClick={() => setSelectedDiel(d)}
            >
              {DIEL_PERIOD_LABELS[d]}
            </Button>
          ))}
        </div>
      )}
      {dielGroups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin datos para {DIEL_PERIOD_LABELS[selectedDiel].toLowerCase()}.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {DESCRIPTORS.map((desc) => (
            <BoxPlot
              key={desc.key}
              groups={toBoxPlotGroups(dielGroups, desc.key)}
              title={desc.title}
              valueLabel={desc.title}
              unitLabel={desc.unitLabel}
              formatValue={(v) => v.toFixed(3)}
              formatTickLabel={(v) => v.toFixed(2)}
              emptyMessage="Sin datos."
            />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Cada punto representa la mediana de un despliegue en{" "}
        {DIEL_PERIOD_LABELS[selectedDiel].toLowerCase()}. Los índices acústicos
        se calculan automáticamente y no requieren verificación humana.
      </p>
    </div>
  );
}

function toBoxPlotGroups(
  groups: AcousticIndicesGroup[],
  indexKey: IndexKey,
): BoxPlotGroup[] {
  return groups.map((g) => ({
    key: `${g.habitatKey}-${g.dielPeriod}`,
    label: g.habitatLabel,
    color: g.color,
    points: g.points.map((p) => ({
      id: p.deploymentId,
      value: p[indexKey],
      primaryLabel: p.deploymentName,
      secondaryLabel: p.siteName ?? undefined,
      footnote: `n=${p.nFiles} archivos`,
    })),
  }));
}

function dielPeriodsPresent(
  groups: AcousticIndicesGroup[],
): DielPeriod[] {
  const present = new Set<DielPeriod>();
  for (const g of groups) {
    if (g.points.length > 0) present.add(g.dielPeriod);
  }
  return DIEL_PERIODS.filter((d) => present.has(d));
}
