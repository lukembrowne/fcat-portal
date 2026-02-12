"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { ClimateResolution } from "@/db/schema";
import { FilterBar, getDateRange } from "./filter-bar";
import type { DateSelection } from "./filter-bar";
import { ClimateCharts } from "./climate-charts";
import type { ChartTab } from "./climate-charts";
import { ClimateTable } from "./climate-table";
import { AboutContent } from "../about/about-content";
import {
  fetchClimateChartData,
  fetchAvailableYears,
  fetchClimateReadingCount,
} from "./actions";
import type {
  ChartDataPoint,
  ClimateFilters,
  AggregationLevel,
} from "./actions";

interface DashboardShellProps {
  hasData: boolean;
  canEdit?: boolean;
}

export function DashboardShell({ hasData, canEdit = false }: DashboardShellProps) {
  const [dateSelection, setDateSelection] = useState<DateSelection>({ type: "all" });
  const [resolution, setResolution] = useState<ClimateResolution>("hourly");
  const [aggregation, setAggregation] = useState<AggregationLevel>("monthly");
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [activeAggregation, setActiveAggregation] = useState<AggregationLevel>("monthly");
  const [activeTab, setActiveTab] = useState<ChartTab>("temperatura");
  const [error, setError] = useState<string | null>(null);
  const [rawWarning, setRawWarning] = useState<{ count: number } | null>(null);

  // Load available years when resolution changes
  useEffect(() => {
    if (!hasData) return;
    fetchAvailableYears(resolution).then((result) => {
      if (result.success) setAvailableYears(result.data);
    });
  }, [hasData, resolution]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRawWarning(null);

    const range = getDateRange(dateSelection);
    const filters: ClimateFilters = {
      dateStart: range.start,
      dateEnd: range.end,
      resolution,
    };

    // If user requested raw, check count first
    if (aggregation === "raw") {
      const countResult = await fetchClimateReadingCount(filters);
      if (countResult.success && countResult.data > 10000) {
        setRawWarning({ count: countResult.data });
        setLoading(false);
        return;
      }
    }

    const chartResult = await fetchClimateChartData(filters, aggregation);

    if (!chartResult.success) {
      setError(chartResult.error);
      setLoading(false);
      return;
    }

    setChartData(chartResult.data.data);
    setActiveAggregation(chartResult.data.aggregation);
    setLoading(false);
  }, [dateSelection, resolution, aggregation]);

  // Force-load raw data bypassing warning
  const forceLoadRaw = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRawWarning(null);

    const range = getDateRange(dateSelection);
    const filters: ClimateFilters = {
      dateStart: range.start,
      dateEnd: range.end,
      resolution,
    };

    const chartResult = await fetchClimateChartData(filters, "raw");

    if (!chartResult.success) {
      setError(chartResult.error);
      setLoading(false);
      return;
    }

    setChartData(chartResult.data.data);
    setActiveAggregation(chartResult.data.aggregation);
    setLoading(false);
  }, [dateSelection, resolution]);

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
    activeAggregation === "daily"
      ? "Datos agregados por día"
      : activeAggregation === "monthly"
        ? "Datos agregados por mes"
        : activeAggregation === "yearly"
          ? "Datos agregados por año (excl. 2021)"
          : null;

  const currentRange = getDateRange(dateSelection);
  const currentFilters: ClimateFilters = {
    dateStart: currentRange.start,
    dateEnd: currentRange.end,
    resolution,
  };

  return (
    <div className="space-y-6 min-w-0">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Datos Climáticos</h1>
        <p className="text-muted-foreground mt-1">
          Estación meteorológica central FCAT
        </p>
      </div>

      <FilterBar
        dateSelection={dateSelection}
        resolution={resolution}
        aggregation={aggregation}
        availableYears={availableYears}
        onDateSelectionChange={setDateSelection}
        onResolutionChange={setResolution}
        onAggregationChange={setAggregation}
        aggregationNote={aggregationNote}
      />

      {rawWarning ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-6 space-y-3">
          <p className="text-amber-800 dark:text-amber-200 font-medium">
            Esto puede ser lento con {rawWarning.count.toLocaleString()} registros sin agregar.
          </p>
          <p className="text-sm text-amber-700 dark:text-amber-300">
            ¿Continuar sin agregación, o cambiar a diario/mensual?
          </p>
          <div className="flex gap-2">
            <button
              className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
              onClick={forceLoadRaw}
            >
              Continuar sin agregar
            </button>
            <button
              className="rounded-md border border-amber-400 px-3 py-1.5 text-sm font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/30"
              onClick={() => setAggregation("daily")}
            >
              Usar diario
            </button>
          </div>
        </div>
      ) : loading ? (
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
          <ClimateCharts
            data={chartData}
            aggregation={activeAggregation}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
          <Separator />
          <AboutContent />
          <Separator />
          <ClimateTable filters={currentFilters} canEdit={canEdit} />
        </>
      )}
    </div>
  );
}
