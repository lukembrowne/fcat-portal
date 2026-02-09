"use client";

import { useState, useMemo } from "react";
import { Separator } from "@/components/ui/separator";
import type { CacaoRecord, CacaoMetrics, CacaoFilterState } from "@/lib/odk-types";
import { MetricsRow } from "./metrics-row";
import { FilterSidebar } from "./filter-sidebar";
import { CacaoMap } from "./cacao-map";
import { CacaoCharts } from "./cacao-charts";
import { CacaoManagement } from "./cacao-management";
import { CacaoTable } from "./cacao-table";

interface DashboardShellProps {
  records: CacaoRecord[];
}

const emptyFilters: CacaoFilterState = {
  community: "",
  farmCode: "",
  fertilized: "",
  survivalMin: 0,
  survivalMax: 100,
};

export function DashboardShell({ records }: DashboardShellProps) {
  const [filters, setFilters] = useState<CacaoFilterState>(emptyFilters);

  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      if (filters.community && r.community !== filters.community) return false;
      if (filters.farmCode && r.farmCode !== filters.farmCode) return false;
      if (filters.fertilized && r.fertilized !== filters.fertilized) return false;
      if (r.survivalRate != null) {
        if (r.survivalRate < filters.survivalMin) return false;
        if (r.survivalRate > filters.survivalMax) return false;
      }
      return true;
    });
  }, [records, filters]);

  const filteredMetrics = useMemo<CacaoMetrics>(() => {
    const totalPlants = filteredRecords.reduce((sum, r) => sum + (r.plantsPlanted ?? 0), 0);
    const plantsAlive = filteredRecords.reduce((sum, r) => sum + (r.plantsAlive ?? 0), 0);
    const ratesWithData = filteredRecords.filter((r) => r.survivalRate != null);
    const avgSurvival =
      ratesWithData.length > 0
        ? ratesWithData.reduce((sum, r) => sum + r.survivalRate!, 0) / ratesWithData.length
        : 0;
    const communities = new Set(filteredRecords.map((r) => r.community).filter(Boolean));

    return {
      totalFarms: filteredRecords.length,
      totalPlants,
      plantsAlive,
      avgSurvivalRate: Math.round(avgSurvival * 10) / 10,
      communities: communities.size,
    };
  }, [filteredRecords]);

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Monitoreo de Sobrevivencia de Cacao</h1>
        <p className="text-sm text-muted-foreground">
          Datos de monitoreo de supervivencia de cacao desde ODK Central
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-6">
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <FilterSidebar
            records={records}
            filters={filters}
            onFilterChange={setFilters}
            filteredCount={filteredRecords.length}
          />
        </aside>

        <main className="space-y-6 min-w-0">
          <MetricsRow metrics={filteredMetrics} />

          <section>
            <h2 className="text-lg font-semibold mb-3">Ubicaciones de Fincas</h2>
            <CacaoMap records={filteredRecords} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-3">Supervivencia</h2>
            <CacaoCharts records={filteredRecords} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-3">Análisis de Prácticas de Manejo</h2>
            <CacaoManagement records={filteredRecords} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-3">Todos los Registros</h2>
            <CacaoTable records={filteredRecords} />
          </section>
        </main>
      </div>
    </div>
  );
}
