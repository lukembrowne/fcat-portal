"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { ClimateResolution } from "@/db/schema";
import { MetricsRow } from "./metrics-row";
import { FilterBar, getDateRange } from "./filter-bar";
import type { DatePreset } from "./filter-bar";
import { ClimateCharts } from "./climate-charts";
import { ClimateTable } from "./climate-table";
import {
  fetchClimateSummary,
  fetchClimateChartData,
} from "./actions";
import type {
  ClimateSummary,
  ChartDataPoint,
  ClimateFilters,
} from "./actions";

interface DashboardShellProps {
  hasData: boolean;
}

export function DashboardShell({ hasData }: DashboardShellProps) {
  const [datePreset, setDatePreset] = useState<DatePreset>("30d");
  const [resolution, setResolution] = useState<ClimateResolution>("hourly");
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<ClimateSummary | null>(null);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [aggregation, setAggregation] = useState<string>("raw");
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const range = getDateRange(datePreset);
    const filters: ClimateFilters = {
      dateStart: range.start,
      dateEnd: range.end,
      resolution,
    };

    const [summaryResult, chartResult] = await Promise.all([
      fetchClimateSummary(filters),
      fetchClimateChartData(filters),
    ]);

    if (!summaryResult.success) {
      setError(summaryResult.error);
      setLoading(false);
      return;
    }
    if (!chartResult.success) {
      setError(chartResult.error);
      setLoading(false);
      return;
    }

    setSummary(summaryResult.data);
    setChartData(chartResult.data.data);
    setAggregation(chartResult.data.aggregation);
    setLoading(false);
  }, [datePreset, resolution]);

  useEffect(() => {
    if (hasData) {
      loadData();
    } else {
      setLoading(false);
    }
  }, [hasData, loadData]);

  if (!hasData) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Datos Climáticos</h1>
          <p className="text-muted-foreground mt-1">
            Estación meteorológica central FCAT
          </p>
        </div>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-muted-foreground space-y-2">
          <p>No hay datos climáticos.</p>
          <p className="text-sm">
            Un editor puede subir archivos .dat desde la{" "}
            <a href="/climate/upload" className="text-primary underline">
              página de carga de datos
            </a>
            .
          </p>
        </div>
      </div>
    );
  }

  const aggregationNote =
    aggregation === "daily"
      ? "Datos agregados por día"
      : aggregation === "monthly"
        ? "Datos agregados por mes"
        : null;

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Datos Climáticos</h1>
          <p className="text-muted-foreground mt-1">
            Estación meteorológica central FCAT
            {summary?.latestUploadDate && (
              <span className="text-xs ml-2">
                — Últimos datos: {summary.latestUploadDate.slice(0, 10)}
              </span>
            )}
          </p>
        </div>
      </div>

      <FilterBar
        datePreset={datePreset}
        resolution={resolution}
        onDatePresetChange={setDatePreset}
        onResolutionChange={setResolution}
        aggregationNote={aggregationNote}
      />

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-destructive font-medium">Error al cargar datos</p>
          <p className="text-sm text-muted-foreground mt-2">{error}</p>
        </div>
      ) : (
        <>
          {summary && <MetricsRow summary={summary} />}
          <Separator />
          <ClimateCharts data={chartData} aggregation={aggregation} />
          <ClimateTable
            filters={{
              dateStart: getDateRange(datePreset).start,
              dateEnd: getDateRange(datePreset).end,
              resolution,
            }}
          />
        </>
      )}
    </div>
  );
}
