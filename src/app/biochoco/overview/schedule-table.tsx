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
import { Badge } from "@/components/ui/badge";
import type { ScheduleRow } from "@/lib/schedule-types";
import type { SiteInfo } from "./types";
import { getHabitatName, getDeploymentStatus, SPANISH_MONTHS } from "./types";

interface ScheduleTableProps {
  deploymentsThisMonth: ScheduleRow[];
  retrievalsThisMonth: ScheduleRow[];
  sites: SiteInfo[];
  deployedSet: Set<string>;
  retrievedSet: Set<string>;
  selectedMonth: { year: number; month: number };
}

interface CombinedRow {
  date: string;
  type: "deploy" | "retrieve";
  siteId: string;
  siteName: string;
  habitat: string;
  deploymentId: string;
  status: "scheduled" | "deployed" | "retrieved";
}

function statusBadge(status: string) {
  switch (status) {
    case "retrieved":
      return <Badge variant="secondary">Recuperado</Badge>;
    case "deployed":
      return <Badge variant="default">Instalado</Badge>;
    default:
      return <Badge variant="outline">Programado</Badge>;
  }
}

export function ScheduleTable({
  deploymentsThisMonth,
  retrievalsThisMonth,
  sites,
  deployedSet,
  retrievedSet,
  selectedMonth,
}: ScheduleTableProps) {
  const monthLabel = `${SPANISH_MONTHS[selectedMonth.month]} ${selectedMonth.year}`;

  const rows = useMemo<CombinedRow[]>(() => {
    const combined: CombinedRow[] = [];

    for (const r of deploymentsThisMonth) {
      combined.push({
        date: r.plannedDeployDate ?? "",
        type: "deploy",
        siteId: r.siteId,
        siteName: r.siteName,
        habitat: getHabitatName(r.habitatType),
        deploymentId: r.deploymentId,
        status: getDeploymentStatus(r.deploymentId, deployedSet, retrievedSet),
      });
    }

    for (const r of retrievalsThisMonth) {
      combined.push({
        date: r.plannedRetrieveDate ?? "",
        type: "retrieve",
        siteId: r.siteId,
        siteName: r.siteName,
        habitat: getHabitatName(r.habitatType),
        deploymentId: r.deploymentId,
        status: getDeploymentStatus(r.deploymentId, deployedSet, retrievedSet),
      });
    }

    return combined.sort((a, b) => a.date.localeCompare(b.date));
  }, [deploymentsThisMonth, retrievalsThisMonth, deployedSet, retrievedSet]);

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">
        Cronograma — {monthLabel}
      </h2>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          No hay actividades programadas este mes.
        </p>
      ) : (
        <div className="rounded-xl border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>ID Sitio</TableHead>
                <TableHead>Nombre</TableHead>
                <TableHead>Hábitat</TableHead>
                <TableHead>ID Instalación</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  <TableCell className="tabular-nums">{row.date}</TableCell>
                  <TableCell>
                    <span className={row.type === "deploy" ? "text-green-600 font-medium" : "text-orange-600 font-medium"}>
                      {row.type === "deploy" ? "Instalación" : "Recuperación"}
                    </span>
                  </TableCell>
                  <TableCell>{row.siteId}</TableCell>
                  <TableCell>{row.siteName}</TableCell>
                  <TableCell>{row.habitat}</TableCell>
                  <TableCell className="font-mono text-xs">{row.deploymentId}</TableCell>
                  <TableCell>{statusBadge(row.status)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
