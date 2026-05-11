"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HabitatSpeciesRollup } from "../habitat-actions";
import {
  parseHabitatsParam,
  habitatMatches,
  type HabitatFilterOption,
} from "./filter-utils";

const LOW_COVERAGE_THRESHOLD = 4;

interface SpeciesSectionProps {
  title: string;
  description: string;
  emptyMessage: string;
  data: HabitatSpeciesRollup[];
  habitatOptions: HabitatFilterOption[];
  /** Identifier used in the disclosure region's id (for unique a11y ids). */
  idPrefix: string;
}

export function SpeciesSection({
  title,
  description,
  emptyMessage,
  data,
  habitatOptions,
  idPrefix,
}: SpeciesSectionProps) {
  const params = useSearchParams();
  const selected = useMemo(
    () =>
      parseHabitatsParam(
        params.get("h_habitats") ?? undefined,
        habitatOptions,
      ),
    [params, habitatOptions],
  );

  const visible = useMemo(
    () => data.filter((r) => habitatMatches(r.habitatKey, selected)),
    [data, selected],
  );

  const maxSpecies = useMemo(
    () => Math.max(1, ...visible.map((r) => r.speciesCount)),
    [visible],
  );

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay hábitats seleccionados con datos.
          </p>
        ) : (
          <div className="space-y-2">
            {visible.map((rollup) => (
              <HabitatRow
                key={rollup.habitatKey}
                rollup={rollup}
                maxSpecies={maxSpecies}
                idPrefix={idPrefix}
              />
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Sólo se cuentan despliegues verificados. Los despliegues sin animales
          confirmados («verificados vacíos») cuentan en el denominador pero
          aportan 0 especies. Hábitats con menos de {LOW_COVERAGE_THRESHOLD}{" "}
          despliegues se muestran atenuados.
        </p>
      </CardContent>
    </Card>
  );
}

function HabitatRow({
  rollup,
  maxSpecies,
  idPrefix,
}: {
  rollup: HabitatSpeciesRollup;
  maxSpecies: number;
  idPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  const isLowCoverage = rollup.verifiedDeploymentCount < LOW_COVERAGE_THRESHOLD;
  const barWidth = Math.max(2, Math.round((rollup.speciesCount / maxSpecies) * 100));
  const regionId = `${idPrefix}-${rollup.habitatKey}-species`;
  const hasSpecies = rollup.topSpecies.length > 0;

  return (
    <div
      className={cn(
        "rounded-md border bg-card",
        isLowCoverage && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={() => hasSpecies && setOpen((v) => !v)}
        disabled={!hasSpecies}
        aria-expanded={open}
        aria-controls={regionId}
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2 text-left",
          hasSpecies && "cursor-pointer hover:bg-muted/40",
          !hasSpecies && "cursor-default",
        )}
      >
        <span
          aria-hidden
          className="inline-block h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: rollup.color }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium">
              {rollup.habitatLabel}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {rollup.verifiedDeploymentCount} de{" "}
              {rollup.totalDeploymentCount} verificados
              {isLowCoverage ? " · cobertura baja" : ""}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${barWidth}%`,
                  backgroundColor: rollup.color,
                }}
              />
            </div>
            <div className="shrink-0 text-right text-xs tabular-nums">
              <span className="font-semibold">{rollup.speciesCount}</span>{" "}
              <span className="text-muted-foreground">especies</span>
              <span className="ml-2 text-muted-foreground">
                · {rollup.detectionCount.toLocaleString("es-ES")} detecciones
              </span>
            </div>
          </div>
        </div>
        {hasSpecies ? (
          open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )
        ) : null}
      </button>
      {open && hasSpecies && (
        <div
          id={regionId}
          className="border-t bg-muted/30 px-3 py-2"
        >
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Especies más detectadas
          </p>
          <ul className="space-y-1">
            {rollup.topSpecies.map((s) => (
              <li
                key={s.speciesName}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="italic">{s.speciesName}</span>
                  {s.spanishName && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({s.spanishName})
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {s.detectionCount.toLocaleString("es-ES")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
