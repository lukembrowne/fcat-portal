"use client";

import { useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle } from "lucide-react";
import type { ScheduleRow } from "@/lib/schedule-types";

const NORMAL_MIN = 25;
const NORMAL_MAX = 35;

interface DurationRow {
  deploymentId: string;
  plannedDeployDate: string;
  plannedRetrieveDate: string;
  days: number;
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 86400000;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / msPerDay);
}

function DurationMiniTable({ title, rows }: { title: string; rows: DurationRow[] }) {
  return (
    <div>
      <h4 className="text-sm font-medium mb-2">{title}</h4>
      <div className="rounded-xl border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID Instalación</TableHead>
              <TableHead>Fecha Instalar</TableHead>
              <TableHead>Fecha Recuperar</TableHead>
              <TableHead className="text-right">Días</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                  Sin datos
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow
                  key={r.deploymentId}
                  className={
                    r.days < NORMAL_MIN || r.days > NORMAL_MAX
                      ? "bg-red-50"
                      : ""
                  }
                >
                  <TableCell className="font-mono text-xs">{r.deploymentId}</TableCell>
                  <TableCell className="tabular-nums">{r.plannedDeployDate}</TableCell>
                  <TableCell className="tabular-nums">{r.plannedRetrieveDate}</TableCell>
                  <TableCell className="tabular-nums text-right">{r.days}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function DurationOutliersTable({ schedule }: { schedule: ScheduleRow[] }) {
  const durations = useMemo<DurationRow[]>(() => {
    return schedule
      .filter((r) => r.plannedDeployDate && r.plannedRetrieveDate)
      .map((r) => ({
        deploymentId: r.deploymentId,
        plannedDeployDate: r.plannedDeployDate!,
        plannedRetrieveDate: r.plannedRetrieveDate!,
        days: daysBetween(r.plannedDeployDate!, r.plannedRetrieveDate!),
      }));
  }, [schedule]);

  const longest = useMemo(
    () => [...durations].sort((a, b) => b.days - a.days).slice(0, 10),
    [durations],
  );

  const shortest = useMemo(
    () => [...durations].sort((a, b) => a.days - b.days).slice(0, 10),
    [durations],
  );

  const outlierCount = useMemo(
    () => durations.filter((d) => d.days < NORMAL_MIN || d.days > NORMAL_MAX).length,
    [durations],
  );

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">
        Duraciones de Instalación — Outliers
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DurationMiniTable title="Top 10 más largos" rows={longest} />
        <DurationMiniTable title="Top 10 más cortos" rows={shortest} />
      </div>

      {outlierCount > 0 && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p>
            {outlierCount} instalación{outlierCount !== 1 ? "es" : ""} fuera del rango normal ({NORMAL_MIN}–{NORMAL_MAX} días).
          </p>
        </div>
      )}
    </section>
  );
}
