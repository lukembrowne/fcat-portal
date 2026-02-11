"use client";

import { useState } from "react";
import type { SueldosData } from "./actions";
import { MetricsRow } from "./metrics-row";
import { SueldosCharts } from "./sueldos-charts";

type GrantFilter = "all" | "funded" | "pending";

export function DashboardShell({ data }: { data: SueldosData }) {
  const [grantFilter, setGrantFilter] = useState<GrantFilter>("all");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Sueldos</h1>
      <MetricsRow
        totalSpent={data.totalSpent}
        grantFilter={grantFilter}
        onFilterChange={setGrantFilter}
      />
      <SueldosCharts
        personData={data.personData}
        grantFilter={grantFilter}
      />
    </div>
  );
}
