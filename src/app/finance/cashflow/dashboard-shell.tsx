"use client";

import type { CashflowData } from "./actions";
import { MetricsRow } from "./metrics-row";
import { CashflowCharts } from "./cashflow-charts";
import { ProjectionsTable } from "./projections-table";
import { BalanceTable } from "./balance-table";

export function DashboardShell({ data }: { data: CashflowData }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Flujo de Caja</h1>
      <MetricsRow metrics={data.metrics} />
      <CashflowCharts
        monthRows={data.monthRows}
        revenueByMonth={data.revenueByMonth}
        expensesByMonth={data.expensesByMonth}
        cashReserveTarget={data.cashReserveTarget}
      />
      <ProjectionsTable projections={data.projections} />
      <BalanceTable monthRows={data.monthRows} />
    </div>
  );
}
