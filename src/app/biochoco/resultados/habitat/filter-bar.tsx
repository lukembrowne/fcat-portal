"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  DIEL_PERIOD_LABELS,
  type DielPeriod,
} from "@/lib/acoustic-indices";
import { Button } from "@/components/ui/button";
import {
  parseHabitats,
  parseDiel,
  type HabitatFilterOption,
} from "./filter-utils";

interface FilterBarProps {
  habitatOptions: HabitatFilterOption[];
  /** Diel periods that have any data; periods absent are hidden. */
  availableDielPeriods: DielPeriod[];
}

/**
 * Sticky filter bar for the "Por hábitat" tab. State lives in the URL so
 * the view is deep-linkable:
 *   ?h_habitats=primary_forest,secondary_forest&h_diel=dawn
 * Empty value (or absent param) means "all".
 */
export function FilterBar({ habitatOptions, availableDielPeriods }: FilterBarProps) {
  const router = useRouter();
  const params = useSearchParams();

  const selectedHabitats = useMemo(
    () => parseHabitats(params.get("h_habitats"), habitatOptions),
    [params, habitatOptions],
  );
  const selectedDiel = parseDiel(params.get("h_diel"), availableDielPeriods);

  const update = useCallback(
    (next: { habitats?: Set<string>; diel?: DielPeriod }) => {
      const sp = new URLSearchParams(params.toString());
      sp.set("view", "habitat");

      if (next.habitats !== undefined) {
        const all = next.habitats.size === habitatOptions.length;
        if (all || next.habitats.size === 0) {
          sp.delete("h_habitats");
        } else {
          sp.set(
            "h_habitats",
            Array.from(next.habitats).sort().join(","),
          );
        }
      }
      if (next.diel !== undefined) {
        if (next.diel === availableDielPeriods[0]) {
          sp.delete("h_diel");
        } else {
          sp.set("h_diel", next.diel);
        }
      }
      router.replace(`/biochoco/resultados?${sp.toString()}`, { scroll: false });
    },
    [params, router, habitatOptions, availableDielPeriods],
  );

  const toggleHabitat = (key: string) => {
    const current = new Set(selectedHabitats);
    if (current.has(key)) {
      current.delete(key);
    } else {
      current.add(key);
    }
    update({ habitats: current });
  };

  const clearHabitats = () => update({ habitats: new Set() });

  return (
    <div className="sticky top-0 z-20 -mx-2 mb-4 rounded-md border bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex flex-col gap-3">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Hábitats
            </span>
            {selectedHabitats.size > 0 &&
              selectedHabitats.size < habitatOptions.length && (
                <button
                  type="button"
                  onClick={clearHabitats}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Mostrar todos
                </button>
              )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {habitatOptions.map((opt) => {
              const isOn =
                selectedHabitats.size === 0 || selectedHabitats.has(opt.key);
              return (
                <button
                  type="button"
                  key={opt.key}
                  onClick={() => toggleHabitat(opt.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    isOn
                      ? "border-transparent bg-muted text-foreground"
                      : "border-muted text-muted-foreground line-through opacity-60",
                  )}
                  aria-pressed={isOn}
                >
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: opt.color }}
                  />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {availableDielPeriods.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Periodo del día
              </span>
              <span className="text-xs text-muted-foreground">
                (sólo afecta los índices acústicos)
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {availableDielPeriods.map((d) => (
                <Button
                  key={d}
                  type="button"
                  variant={d === selectedDiel ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => update({ diel: d })}
                >
                  {DIEL_PERIOD_LABELS[d]}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
