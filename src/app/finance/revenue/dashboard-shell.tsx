"use client";

import { useMemo } from "react";
import { MetricsRow } from "./metrics-row";
import { RevenueCharts } from "./revenue-charts";
import { RevenueTable } from "./revenue-table";
import { formatDataThrough } from "../lib/format-data-through";
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
      <div>
        <h1 className="text-2xl font-bold">Ingresos</h1>
        <p className="text-xs text-muted-foreground mt-1">
          {formatDataThrough(data.dataThrough)}
        </p>
      </div>
      <MetricsRow totalRevenue={formattedTotal} />
      <RevenueCharts byCategory={data.byCategory} byMonth={data.byMonth} />
      <RevenueTable transactions={data.transactions} />
    </div>
  );
}
