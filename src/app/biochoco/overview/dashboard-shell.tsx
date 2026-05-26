"use client";

import { useState, useMemo, useRef, useCallback } from "react";
import { Separator } from "@/components/ui/separator";
import { CompactStatBar } from "@/components/compact-stat-bar";
import { Upload, Download, MapPin, CalendarCheck, Clock, CheckCircle, Map } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BiochocoOverviewData } from "./types";
import { SPANISH_MONTHS } from "./types";
import { OverviewMap } from "./overview-map";
import { ScheduleTable } from "./schedule-table";
import { HabitatChart } from "./habitat-chart";
import { FieldNotesTable } from "./field-notes-table";
import { WorkloadTable } from "./workload-table";
import { DurationOutliersTable } from "./duration-outliers-table";

export function DashboardShell({
  data,
  canEditNotes = false,
  canEditSchedule = false,
}: {
  data: BiochocoOverviewData;
  canEditNotes?: boolean;
  canEditSchedule?: boolean;
}) {
  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState({
    year: now.getFullYear(),
    month: now.getMonth(),
  });

  const deployedSet = useMemo(() => new Set(data.deployedIds), [data.deployedIds]);
  const retrievedSet = useMemo(() => new Set(data.retrievedIds), [data.retrievedIds]);

  const flyToSiteRef = useRef<((lat: number, lng: number) => void) | null>(null);
  const handleMapReady = useCallback((fn: (lat: number, lng: number) => void) => {
    flyToSiteRef.current = fn;
  }, []);
  const handleFocusSite = useCallback((lat: number, lng: number) => {
    flyToSiteRef.current?.(lat, lng);
    document.getElementById("overview-map")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // Filter schedule to selected month
  const deploymentsThisMonth = useMemo(() => {
    return data.schedule.filter((r) => {
      if (!r.plannedDeployDate) return false;
      const d = new Date(r.plannedDeployDate);
      return d.getMonth() === selectedMonth.month && d.getFullYear() === selectedMonth.year;
    });
  }, [data.schedule, selectedMonth]);

  const retrievalsThisMonth = useMemo(() => {
    return data.schedule.filter((r) => {
      if (!r.plannedRetrieveDate) return false;
      const d = new Date(r.plannedRetrieveDate);
      return d.getMonth() === selectedMonth.month && d.getFullYear() === selectedMonth.year;
    });
  }, [data.schedule, selectedMonth]);

  function prevMonth() {
    setSelectedMonth((prev) => {
      if (prev.month === 0) return { year: prev.year - 1, month: 11 };
      return { ...prev, month: prev.month - 1 };
    });
  }

  function nextMonth() {
    setSelectedMonth((prev) => {
      if (prev.month === 11) return { year: prev.year + 1, month: 0 };
      return { ...prev, month: prev.month + 1 };
    });
  }

  // Project-level stats
  const projectStats = useMemo(() => {
    const total = data.schedule.length;
    const deployed = deployedSet.size;
    const retrieved = retrievedSet.size;
    const scheduled = total - deployed;
    const currentlyDeployed = deployed - retrieved;
    const completionPct = total > 0 ? Math.round((retrieved / total) * 1000) / 10 : 0;

    const deployDates = data.schedule.map((r) => r.plannedDeployDate).filter(Boolean) as string[];
    const retrieveDates = data.schedule.map((r) => r.plannedRetrieveDate).filter(Boolean) as string[];
    const firstDeploy = deployDates.length > 0 ? deployDates.sort()[0] : null;
    const lastDeploy = deployDates.length > 0 ? deployDates.sort().at(-1)! : null;
    const lastRetrieve = retrieveDates.length > 0 ? retrieveDates.sort().at(-1)! : null;

    const durations = data.schedule
      .filter((r) => r.plannedDeployDate && r.plannedRetrieveDate)
      .map((r) => {
        const dep = new Date(r.plannedDeployDate!);
        const ret = new Date(r.plannedRetrieveDate!);
        return Math.round((ret.getTime() - dep.getTime()) / (1000 * 60 * 60 * 24));
      });
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const minDuration = durations.length > 0 ? Math.min(...durations) : 0;
    const maxDuration = durations.length > 0 ? Math.max(...durations) : 0;
    const uniqueSites = new Set(data.schedule.map((r) => r.siteId)).size;

    return {
      total, scheduled, currentlyDeployed, retrieved, completionPct,
      firstDeploy, lastDeploy, lastRetrieve,
      avgDuration, minDuration, maxDuration, uniqueSites,
    };
  }, [data.schedule, deployedSet, retrievedSet]);

  const monthLabel = `${SPANISH_MONTHS[selectedMonth.month]} ${selectedMonth.year}`;

  const notesCount = useMemo(
    () => data.schedule.filter((r) => r.fieldNotes && r.fieldNotes.trim().length > 0).length,
    [data.schedule],
  );

  function formatDateShort(dateStr: string | null): string {
    if (!dateStr) return "N/A";
    const d = new Date(dateStr);
    return `${d.getDate()} ${SPANISH_MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
  }

  return (
    <div className="space-y-6 overflow-hidden">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Panel BioChoco</h1>
          <p className="text-sm text-muted-foreground">
            Monitoreo de biodiversidad en el Chocó ecuatoriano
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => document.getElementById("overview-map")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        >
          <Map className="h-4 w-4 mr-1" />
          Ir al mapa
        </Button>
      </div>

      {/* Combined project + month stats */}
      <div className="space-y-2">
        <CompactStatBar
          stats={[
            { icon: <CalendarCheck className="h-4 w-4 text-blue-600" />, value: projectStats.total, label: "Total" },
            { icon: <Clock className="h-4 w-4 text-gray-600" />, value: projectStats.scheduled, label: "Programados" },
            { icon: <MapPin className="h-4 w-4 text-green-600" />, value: projectStats.currentlyDeployed, label: "Instalados" },
            { icon: <CheckCircle className="h-4 w-4 text-orange-600" />, value: `${projectStats.retrieved} (${projectStats.completionPct}%)`, label: "Completados" },
            { icon: <Upload className="h-4 w-4 text-green-600" />, value: deploymentsThisMonth.length, label: `Instalar ${monthLabel}` },
            { icon: <Download className="h-4 w-4 text-orange-600" />, value: retrievalsThisMonth.length, label: `Recuperar ${monthLabel}` },
          ]}
        />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>Primera: {formatDateShort(projectStats.firstDeploy)}</span>
          <span className="hidden sm:inline">&middot;</span>
          <span>Última: {formatDateShort(projectStats.lastDeploy)}</span>
          <span className="hidden sm:inline">&middot;</span>
          <span>Fin: {formatDateShort(projectStats.lastRetrieve)}</span>
          <span className="hidden sm:inline">&middot;</span>
          <span>Duración: {projectStats.avgDuration}d promedio ({projectStats.minDuration}–{projectStats.maxDuration}d)</span>
          <span className="hidden sm:inline">&middot;</span>
          <span>{projectStats.uniqueSites} sitios</span>
        </div>
      </div>

      <Separator />

      <ScheduleTable
        deploymentsThisMonth={deploymentsThisMonth}
        retrievalsThisMonth={retrievalsThisMonth}
        allSchedule={data.schedule}
        sites={data.sites}
        deployedSet={deployedSet}
        retrievedSet={retrievedSet}
        selectedMonth={selectedMonth}
        canEditNotes={canEditNotes}
        canEditSchedule={canEditSchedule}
        onFocusSite={handleFocusSite}
        onPrevMonth={prevMonth}
        onNextMonth={nextMonth}
      />

      <Separator />

      <section id="overview-map">
        <h2 className="text-lg font-semibold mb-3">Mapa de Sitios</h2>
        <OverviewMap
          sites={data.sites}
          deploymentsThisMonth={deploymentsThisMonth}
          retrievalsThisMonth={retrievalsThisMonth}
          deployedSet={deployedSet}
          retrievedSet={retrievedSet}
          onMapReady={handleMapReady}
        />
      </section>

      <Separator />

      <section>
        <h2 className="text-lg font-semibold mb-3">Instalaciones por Tipo de Hábitat</h2>
        <HabitatChart schedule={data.schedule} deployedSet={deployedSet} retrievedSet={retrievedSet} />
      </section>

      <Separator />

      <section>
        <h2 className="text-lg font-semibold mb-3">
          Notas de Campo{" "}
          <span className="text-sm font-normal text-muted-foreground">({notesCount})</span>
        </h2>
        <FieldNotesTable
          schedule={data.schedule}
          deployedSet={deployedSet}
          retrievedSet={retrievedSet}
        />
      </section>

      <Separator />

      <section>
        <h2 className="text-lg font-semibold mb-3">Carga de Trabajo Mensual</h2>
        <WorkloadTable schedule={data.schedule} />
      </section>

      <Separator />

      <DurationOutliersTable schedule={data.schedule} />
    </div>
  );
}
