"use client";

import { useMemo, useState } from "react";
import type { CashflowData } from "./actions";
import { MetricsRow } from "./metrics-row";
import { CashflowCharts } from "./cashflow-charts";
import { ProjectionsTable } from "./projections-table";
import { BalanceTable } from "./balance-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Sentinel for "show all years" (no lower bound). */
const ALL_YEARS = 0;
/** Default lower bound: hide months before this year. */
const DEFAULT_FROM_YEAR = 2026;

function yearOf(yearMonth: string): number {
  return parseInt(yearMonth.slice(0, 4), 10);
}

export function DashboardShell({ data }: { data: CashflowData }) {
  // Years present in the actual monthly series (ascending).
  const availableYears = useMemo(() => {
    const set = new Set<number>();
    for (const row of data.monthRows) set.add(yearOf(row.yearMonth));
    return [...set].sort((a, b) => a - b);
  }, [data.monthRows]);

  const minYear = availableYears[0] ?? DEFAULT_FROM_YEAR;
  // Clamp the default: if all data is already >= 2026, the default hides nothing.
  const initialFromYear =
    minYear >= DEFAULT_FROM_YEAR ? ALL_YEARS : DEFAULT_FROM_YEAR;

  const [fromYear, setFromYear] = useState<number>(initialFromYear);

  // Display-only filter. Metrics (runway) and projections stay on full data.
  const filteredMonthRows = useMemo(
    () =>
      fromYear === ALL_YEARS
        ? data.monthRows
        : data.monthRows.filter((r) => yearOf(r.yearMonth) >= fromYear),
    [data.monthRows, fromYear]
  );

  const filteredRevenueByMonth = useMemo(
    () =>
      fromYear === ALL_YEARS
        ? data.revenueByMonth
        : data.revenueByMonth.filter((r) => yearOf(r.yearMonth) >= fromYear),
    [data.revenueByMonth, fromYear]
  );

  const filteredExpensesByMonth = useMemo(
    () =>
      fromYear === ALL_YEARS
        ? data.expensesByMonth
        : data.expensesByMonth.filter((r) => yearOf(r.yearMonth) >= fromYear),
    [data.expensesByMonth, fromYear]
  );

  // Only offer year options that actually hide something.
  const yearOptions = availableYears.filter(
    (y) => y > (availableYears[0] ?? y)
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Flujo de Caja</h1>
        {yearOptions.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Desde:</span>
            <Select
              value={String(fromYear)}
              onValueChange={(v) => setFromYear(Number(v))}
            >
              <SelectTrigger className="h-8 w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={String(ALL_YEARS)}>Todos los años</SelectItem>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <MetricsRow metrics={data.metrics} />
      <CashflowCharts
        monthRows={filteredMonthRows}
        revenueByMonth={filteredRevenueByMonth}
        expensesByMonth={filteredExpensesByMonth}
        cashReserveTarget={data.cashReserveTarget}
      />
      <ProjectionsTable projections={data.projections} />
      <BalanceTable monthRows={filteredMonthRows} />
    </div>
  );
}
