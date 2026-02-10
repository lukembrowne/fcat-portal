"use client";

import { useMemo } from "react";
import { MetricsRow } from "./metrics-row";
import { ExpenseCharts } from "./expense-charts";
import { ExpensePivot } from "./expense-pivot";
import { ExpenseTable } from "./expense-table";
import type { ExpenseData } from "./actions";

export function DashboardShell({ data }: { data: ExpenseData }) {
  const formattedTotal = useMemo(
    () =>
      data.totalExpenses.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
      }),
    [data.totalExpenses]
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Gastos</h1>
      <MetricsRow totalExpenses={formattedTotal} />
      <ExpenseCharts byCategory={data.byCategory} byMonth={data.byMonth} />
      <ExpensePivot pivotData={data.pivotData} byMonth={data.byMonth} />
      <ExpenseTable transactions={data.transactions} />
    </div>
  );
}
