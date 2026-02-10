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

interface VisitDates {
  plan: string | null;
  real: string | null;
}

interface SiteSummaryRow {
  siteId: string;
  siteName: string;
  v1: VisitDates;
  v2: VisitDates;
  v3: VisitDates;
  v1v2Days: number | null;
  v2v3Days: number | null;
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 86400000;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / msPerDay);
}

export function SiteSummaryTable({
  schedule,
}: {
  schedule: ScheduleRow[];
}) {
  const summaryRows = useMemo<SiteSummaryRow[]>(() => {
    // Group by siteId
    const siteMap = new Map<string, { siteName: string; visits: Map<number, ScheduleRow> }>();

    for (const r of schedule) {
      if (!siteMap.has(r.siteId)) {
        siteMap.set(r.siteId, { siteName: r.siteName, visits: new Map() });
      }
      const entry = siteMap.get(r.siteId)!;
      // Keep the first row per visit number (shouldn't have duplicates, but just in case)
      if (!entry.visits.has(r.visitNumber)) {
        entry.visits.set(r.visitNumber, r);
      }
    }

    const rows: SiteSummaryRow[] = [];

    for (const [siteId, { siteName, visits }] of siteMap) {
      const v1row = visits.get(1);
      const v2row = visits.get(2);
      const v3row = visits.get(3);

      const v1: VisitDates = {
        plan: v1row?.plannedDeployDate ?? null,
        real: v1row?.actualDeployDate ?? null,
      };
      const v2: VisitDates = {
        plan: v2row?.plannedDeployDate ?? null,
        real: v2row?.actualDeployDate ?? null,
      };
      const v3: VisitDates = {
        plan: v3row?.plannedDeployDate ?? null,
        real: v3row?.actualDeployDate ?? null,
      };

      const v1v2Days =
        v1.plan && v2.plan ? daysBetween(v1.plan, v2.plan) : null;
      const v2v3Days =
        v2.plan && v3.plan ? daysBetween(v2.plan, v3.plan) : null;

      rows.push({ siteId, siteName, v1, v2, v3, v1v2Days, v2v3Days });
    }

    return rows.sort((a, b) => a.siteId.localeCompare(b.siteId));
  }, [schedule]);

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">
        Resumen de Instalaciones por Sitio
      </h2>

      <div className="rounded-xl border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead rowSpan={2}>ID Sitio</TableHead>
              <TableHead rowSpan={2}>Nombre</TableHead>
              <TableHead colSpan={2} className="text-center border-l">V1</TableHead>
              <TableHead colSpan={2} className="text-center border-l">V2</TableHead>
              <TableHead colSpan={2} className="text-center border-l">V3</TableHead>
              <TableHead className="text-center border-l">V1→V2</TableHead>
              <TableHead className="text-center border-l">V2→V3</TableHead>
            </TableRow>
            <TableRow>
              <TableHead className="border-l">Plan</TableHead>
              <TableHead>Real</TableHead>
              <TableHead className="border-l">Plan</TableHead>
              <TableHead>Real</TableHead>
              <TableHead className="border-l">Plan</TableHead>
              <TableHead>Real</TableHead>
              <TableHead className="text-right border-l">Días</TableHead>
              <TableHead className="text-right border-l">Días</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaryRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                  Sin datos de instalaciones
                </TableCell>
              </TableRow>
            ) : (
              summaryRows.map((row) => (
                <TableRow key={row.siteId}>
                  <TableCell className="font-mono text-xs">{row.siteId}</TableCell>
                  <TableCell>{row.siteName}</TableCell>
                  <TableCell className="tabular-nums border-l">{row.v1.plan ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{row.v1.real ?? "—"}</TableCell>
                  <TableCell className="tabular-nums border-l">{row.v2.plan ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{row.v2.real ?? "—"}</TableCell>
                  <TableCell className="tabular-nums border-l">{row.v3.plan ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{row.v3.real ?? "—"}</TableCell>
                  <TableCell className="tabular-nums text-right border-l">
                    {row.v1v2Days != null ? row.v1v2Days : "—"}
                  </TableCell>
                  <TableCell className="tabular-nums text-right border-l">
                    {row.v2v3Days != null ? row.v2v3Days : "—"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
