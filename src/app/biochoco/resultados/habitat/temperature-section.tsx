"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BoxPlot, type BoxPlotGroup } from "@/components/box-plot";
import type { DeploymentStatPoint } from "@/app/biochoco/ibutton/types";
import { habitatFilter, type HabitatFilterOption } from "./filter-bar";

type TempStat = "tempMin" | "tempMean" | "tempMax";

const STATS: ReadonlyArray<{
  key: TempStat;
  title: string;
  description: string;
}> = [
  {
    key: "tempMin",
    title: "Temperatura mínima",
    description: "La temperatura más fría registrada en cada despliegue.",
  },
  {
    key: "tempMean",
    title: "Temperatura promedio",
    description: "La temperatura promedio de cada despliegue.",
  },
  {
    key: "tempMax",
    title: "Temperatura máxima",
    description: "La temperatura más caliente registrada en cada despliegue.",
  },
];

interface TemperatureSectionProps {
  points: DeploymentStatPoint[];
  habitatOptions: HabitatFilterOption[];
}

export function TemperatureSection({
  points,
  habitatOptions,
}: TemperatureSectionProps) {
  const params = useSearchParams();
  const selected = useMemo(
    () =>
      habitatFilter.parseHabitats(
        params.get("h_habitats") ?? undefined,
        habitatOptions,
      ),
    [params, habitatOptions],
  );

  const filteredPoints = useMemo(
    () => points.filter((p) => habitatFilter.matches(p.habitatType, selected)),
    [points, selected],
  );

  if (points.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Distribución de temperaturas por hábitat
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No hay datos de temperatura procesados todavía.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Distribución de temperaturas por hábitat
        </CardTitle>
      </CardHeader>
      <CardContent>
        {filteredPoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay datos para los hábitats seleccionados.
          </p>
        ) : (
          <div className="space-y-4">
            {STATS.map((stat) => (
              <BoxPlot
                key={stat.key}
                groups={toBoxPlotGroups(
                  filteredPoints,
                  stat.key,
                  habitatOptions,
                )}
                title={stat.title}
                description={stat.description}
                valueLabel={stat.title}
                unitLabel="°C"
                formatValue={(v) => `${v.toFixed(1)}°C`}
                formatTickLabel={(v) => v.toFixed(1)}
                lowCoverageThreshold={4}
                emptyMessage="No hay datos para este estadístico."
              />
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Cada punto representa un despliegue iButton. La caja muestra los
          cuartiles (Q1–Q3) y la mediana; los bigotes muestran el rango
          (Tukey, 1.5 × IQR). Hábitats con menos de 4 despliegues se muestran
          atenuados.
        </p>
      </CardContent>
    </Card>
  );
}

function toBoxPlotGroups(
  points: DeploymentStatPoint[],
  stat: TempStat,
  habitatOptions: HabitatFilterOption[],
): BoxPlotGroup[] {
  const byKey = new Map<string, BoxPlotGroup>();
  const optionMap = new Map(habitatOptions.map((o) => [o.key, o]));
  for (const p of points) {
    const value = p[stat];
    if (value == null || !Number.isFinite(value)) continue;
    const opt = optionMap.get(p.habitatType) ?? {
      key: p.habitatType,
      label: p.habitatLabel ?? p.habitatType,
      color: "#94a3b8",
    };
    const group = byKey.get(opt.key) ?? {
      key: opt.key,
      label: opt.label,
      color: opt.color,
      points: [],
    };
    group.points.push({
      id: p.deploymentId,
      value,
      primaryLabel: p.deploymentName,
      secondaryLabel: p.siteName ?? undefined,
    });
    byKey.set(opt.key, group);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.key === "unknown") return 1;
    if (b.key === "unknown") return -1;
    return a.label.localeCompare(b.label);
  });
}
