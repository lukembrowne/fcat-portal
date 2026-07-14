"use client";

import { AnnualCharts } from "./annual-charts";
import { AnnualTables } from "./annual-tables";
import type { AnnualData } from "./actions";

export function DashboardShell({ data }: { data: AnnualData }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Comparacion Anual</h1>
      <AnnualCharts
        annualSummary={data.annualSummary}
        monthlyRevenue={data.monthlyRevenue}
        monthlyExpenses={data.monthlyExpenses}
      />
      <AnnualTables
        annualSummary={data.annualSummary}
        monthlyExpenses={data.monthlyExpenses}
        expensesByCategory={data.expensesByCategory}
      />
    </div>
  );
}
