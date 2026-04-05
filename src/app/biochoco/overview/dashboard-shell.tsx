"use client";

import { useState, useMemo } from "react";
import { Separator } from "@/components/ui/separator";
import type { BiochocoOverviewData } from "./types";
import { MonthNavigator } from "./month-navigator";
import { OverviewMap } from "./overview-map";
import { ScheduleTable } from "./schedule-table";
import { ProjectSummary } from "./project-summary";
import { HabitatChart } from "./habitat-chart";
import { WorkloadTable } from "./workload-table";
import { DurationOutliersTable } from "./duration-outliers-table";
import { SiteSummaryTable } from "./site-summary-table";

export function DashboardShell({ data, canEditNotes = false }: { data: BiochocoOverviewData; canEditNotes?: boolean }) {
  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState({
    year: now.getFullYear(),
    month: now.getMonth(),
  });

  const deployedSet = useMemo(() => new Set(data.deployedIds), [data.deployedIds]);
  const retrievedSet = useMemo(() => new Set(data.retrievedIds), [data.retrievedIds]);

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

  return (
    <div className="space-y-6 overflow-hidden">
      <div>
        <h1 className="text-2xl font-bold">Panel BioChoco</h1>
        <p className="text-sm text-muted-foreground">
          Monitoreo de biodiversidad en el Chocó ecuatoriano
        </p>
      </div>

      <MonthNavigator
        selectedMonth={selectedMonth}
        deploymentsCount={deploymentsThisMonth.length}
        retrievalsCount={retrievalsThisMonth.length}
        onPrev={prevMonth}
        onNext={nextMonth}
      />

      <section>
        <h2 className="text-lg font-semibold mb-3">Mapa de Sitios</h2>
        <OverviewMap
          sites={data.sites}
          deploymentsThisMonth={deploymentsThisMonth}
          retrievalsThisMonth={retrievalsThisMonth}
          deployedSet={deployedSet}
          retrievedSet={retrievedSet}
        />
      </section>

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
      />

      <Separator />

      <ProjectSummary
        schedule={data.schedule}
        deployedSet={deployedSet}
        retrievedSet={retrievedSet}
      />

      <Separator />

      <section>
        <h2 className="text-lg font-semibold mb-3">Instalaciones por Tipo de Hábitat</h2>
        <HabitatChart schedule={data.schedule} deployedSet={deployedSet} retrievedSet={retrievedSet} />
      </section>

      <Separator />

      <section>
        <h2 className="text-lg font-semibold mb-3">Carga de Trabajo Mensual</h2>
        <WorkloadTable schedule={data.schedule} />
      </section>

      <Separator />

      <DurationOutliersTable schedule={data.schedule} />

      <Separator />

      <SiteSummaryTable schedule={data.schedule} />
    </div>
  );
}
