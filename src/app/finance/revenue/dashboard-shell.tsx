"use client";

import { useMemo } from "react";
import { MetricsRow } from "./metrics-row";
import { RevenueCharts } from "./revenue-charts";
import { RevenueTable } from "./revenue-table";
import type { RevenueData } from "./actions";

export function DashboardShell({ data }: { data: RevenueData }) {
  const formattedTotal = useMemo(
    () =>
      data.totalRevenue.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
      }),
    [data.totalRevenue]
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Ingresos</h1>
      <MetricsRow totalRevenue={formattedTotal} />
      <RevenueCharts byCategory={data.byCategory} byMonth={data.byMonth} />
      <RevenueTable transactions={data.transactions} />
    </div>
  );
}
