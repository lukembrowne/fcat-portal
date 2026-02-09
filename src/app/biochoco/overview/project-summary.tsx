"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarCheck, Clock, MapPin, CheckCircle } from "lucide-react";
import type { ScheduleRow } from "@/lib/schedule-types";
import { SPANISH_MONTHS } from "./types";

interface ProjectSummaryProps {
  schedule: ScheduleRow[];
  deployedSet: Set<string>;
  retrievedSet: Set<string>;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "N/A";
  const d = new Date(dateStr);
  return `${d.getDate()} de ${SPANISH_MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
}

export function ProjectSummary({ schedule, deployedSet, retrievedSet }: ProjectSummaryProps) {
  const stats = useMemo(() => {
    const total = schedule.length;
    const deployed = deployedSet.size;
    const retrieved = retrievedSet.size;
    const scheduled = total - deployed;
    const currentlyDeployed = deployed - retrieved;
    const completionPct = total > 0 ? Math.round((retrieved / total) * 1000) / 10 : 0;

    // Timeline
    const deployDates = schedule.map((r) => r.plannedDeployDate).filter(Boolean) as string[];
    const retrieveDates = schedule.map((r) => r.plannedRetrieveDate).filter(Boolean) as string[];
    const firstDeploy = deployDates.length > 0 ? deployDates.sort()[0] : null;
    const lastDeploy = deployDates.length > 0 ? deployDates.sort().at(-1)! : null;
    const lastRetrieve = retrieveDates.length > 0 ? retrieveDates.sort().at(-1)! : null;

    // Duration stats
    const durations = schedule
      .filter((r) => r.plannedDeployDate && r.plannedRetrieveDate)
      .map((r) => {
        const deploy = new Date(r.plannedDeployDate!);
        const retrieve = new Date(r.plannedRetrieveDate!);
        return Math.round((retrieve.getTime() - deploy.getTime()) / (1000 * 60 * 60 * 24));
      });

    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;
    const minDuration = durations.length > 0 ? Math.min(...durations) : 0;
    const maxDuration = durations.length > 0 ? Math.max(...durations) : 0;

    const uniqueSites = new Set(schedule.map((r) => r.siteId)).size;

    return {
      total, scheduled, currentlyDeployed, retrieved, completionPct,
      firstDeploy, lastDeploy, lastRetrieve,
      avgDuration, minDuration, maxDuration, uniqueSites,
    };
  }, [schedule, deployedSet, retrievedSet]);

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold">Resumen General del Proyecto</h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
            <CalendarCheck className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{stats.total}</div></CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Programados</CardTitle>
            <Clock className="h-4 w-4 text-gray-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{stats.scheduled}</div></CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Instalados</CardTitle>
            <MapPin className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{stats.currentlyDeployed}</div></CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Completados</CardTitle>
            <CheckCircle className="h-4 w-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.retrieved} <span className="text-sm font-normal text-muted-foreground">({stats.completionPct}%)</span></div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Cronología</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p><strong>Primera Instalación:</strong> {formatDate(stats.firstDeploy)}</p>
            <p><strong>Última Instalación:</strong> {formatDate(stats.lastDeploy)}</p>
            <p><strong>Fin del Proyecto:</strong> {formatDate(stats.lastRetrieve)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Estadísticas de Instalación</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p><strong>Duración Promedio:</strong> {stats.avgDuration} días</p>
            <p><strong>Más Corto:</strong> {stats.minDuration} días</p>
            <p><strong>Más Largo:</strong> {stats.maxDuration} días</p>
            <p><strong>Sitios Únicos:</strong> {stats.uniqueSites}</p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
