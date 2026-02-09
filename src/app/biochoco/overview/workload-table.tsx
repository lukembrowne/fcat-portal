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
import type { ScheduleRow } from "@/lib/schedule-types";
import { SPANISH_MONTHS } from "./types";

function monthKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  return `${SPANISH_MONTHS[parseInt(month, 10) - 1]} ${year}`;
}

export function WorkloadTable({ schedule }: { schedule: ScheduleRow[] }) {
  const workload = useMemo(() => {
    const deployByMonth: Record<string, number> = {};
    const retrieveByMonth: Record<string, number> = {};

    for (const row of schedule) {
      if (row.plannedDeployDate) {
        const k = monthKey(row.plannedDeployDate);
        deployByMonth[k] = (deployByMonth[k] ?? 0) + 1;
      }
      if (row.plannedRetrieveDate) {
        const k = monthKey(row.plannedRetrieveDate);
        retrieveByMonth[k] = (retrieveByMonth[k] ?? 0) + 1;
      }
    }

    const allMonths = [...new Set([...Object.keys(deployByMonth), ...Object.keys(retrieveByMonth)])].sort();

    return allMonths.map((m) => ({
      month: monthLabel(m),
      deploys: deployByMonth[m] ?? 0,
      retrieves: retrieveByMonth[m] ?? 0,
      total: (deployByMonth[m] ?? 0) + (retrieveByMonth[m] ?? 0),
    }));
  }, [schedule]);

  if (workload.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin datos</p>;
  }

  return (
    <div className="rounded-xl border overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Mes</TableHead>
            <TableHead className="text-right">Instalaciones</TableHead>
            <TableHead className="text-right">Recuperaciones</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workload.map((row) => (
            <TableRow key={row.month}>
              <TableCell className="font-medium">{row.month}</TableCell>
              <TableCell className="text-right tabular-nums">{row.deploys}</TableCell>
              <TableCell className="text-right tabular-nums">{row.retrieves}</TableCell>
              <TableCell className="text-right tabular-nums font-medium">{row.total}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
