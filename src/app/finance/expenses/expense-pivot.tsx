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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MonthlyAmount } from "../types";

interface PivotRow {
  category: string;
  months: Record<string, number>;
  total: number;
  avgMonthly: number;
}

function formatCurrency(val: number) {
  return "$" + val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMonth(yearMonth: string) {
  const [y, m] = yearMonth.split("-");
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
}

export function ExpensePivot({
  pivotData,
  byMonth,
}: {
  pivotData: PivotRow[];
  byMonth: MonthlyAmount[];
}) {
  // Get sorted unique months from byMonth (already sorted from the server)
  const monthColumns = useMemo(
    () => byMonth.map((m) => m.yearMonth),
    [byMonth]
  );

  // Compute column totals
  const columnTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const ym of monthColumns) {
      totals[ym] = 0;
    }
    let grandTotal = 0;
    let grandAvg = 0;
    for (const row of pivotData) {
      for (const ym of monthColumns) {
        totals[ym] += row.months[ym] ?? 0;
      }
      grandTotal += row.total;
      grandAvg += row.avgMonthly;
    }
    return { months: totals, grandTotal, grandAvg };
  }, [pivotData, monthColumns]);

  if (pivotData.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Gastos por Categoria y Mes</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background z-10 whitespace-nowrap">
                  Categoria
                </TableHead>
                {monthColumns.map((ym) => (
                  <TableHead key={ym} className="text-right whitespace-nowrap">
                    {formatMonth(ym)}
                  </TableHead>
                ))}
                <TableHead className="text-right whitespace-nowrap font-bold">
                  TOTAL
                </TableHead>
                <TableHead className="text-right whitespace-nowrap font-bold">
                  PROMEDIO MENSUAL
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pivotData.map((row) => (
                <TableRow key={row.category}>
                  <TableCell className="sticky left-0 bg-background z-10 whitespace-nowrap font-medium">
                    {row.category}
                  </TableCell>
                  {monthColumns.map((ym) => (
                    <TableCell key={ym} className="text-right tabular-nums whitespace-nowrap">
                      {row.months[ym] ? formatCurrency(row.months[ym]) : "—"}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums whitespace-nowrap font-semibold">
                    {formatCurrency(row.total)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums whitespace-nowrap">
                    {formatCurrency(row.avgMonthly)}
                  </TableCell>
                </TableRow>
              ))}

              {/* Totals row */}
              <TableRow className="border-t-2 font-bold">
                <TableCell className="sticky left-0 bg-background z-10 whitespace-nowrap">
                  TOTAL
                </TableCell>
                {monthColumns.map((ym) => (
                  <TableCell key={ym} className="text-right tabular-nums whitespace-nowrap">
                    {formatCurrency(columnTotals.months[ym])}
                  </TableCell>
                ))}
                <TableCell className="text-right tabular-nums whitespace-nowrap">
                  {formatCurrency(columnTotals.grandTotal)}
                </TableCell>
                <TableCell className="text-right tabular-nums whitespace-nowrap">
                  {formatCurrency(columnTotals.grandAvg)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
