"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PersonPanel } from "./actions";

// Color palette for grant sources
const SOURCE_COLORS = [
  "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#ec4899", "#14b8a6", "#f97316", "#6366f1",
  "#84cc16", "#a855f7", "#d946ef", "#0ea5e9", "#10b981",
];

function fmtMonth(ym: string): string {
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const m = parseInt(ym.slice(5, 7), 10) - 1;
  const y = ym.slice(2, 4);
  return `${months[m]} ${y}`;
}

function fmtCurrency(v: number): string {
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

type GrantFilter = "all" | "funded" | "pending";

export function SueldosCharts({
  personData,
  grantFilter,
}: {
  personData: PersonPanel[];
  grantFilter: GrantFilter;
}) {
  if (personData.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground text-sm">
          Sin datos de sueldos — cargue el archivo de Sueldos primero
        </CardContent>
      </Card>
    );
  }

  // Collect all unique sources for consistent color mapping
  const allSources = new Set<string>();
  for (const pp of personData) {
    for (const m of pp.months) {
      for (const s of m.sources) {
        allSources.add(s.source);
      }
    }
  }
  const sourceList = Array.from(allSources).sort();
  const sourceColorMap = new Map(sourceList.map((s, i) => [s, SOURCE_COLORS[i % SOURCE_COLORS.length]]));

  return (
    <div className="space-y-6">
      {personData.map((panel) => (
        <PersonChart
          key={panel.person}
          panel={panel}
          sourceList={sourceList}
          sourceColorMap={sourceColorMap}
          grantFilter={grantFilter}
        />
      ))}
    </div>
  );
}

function PersonChart({
  panel,
  sourceList,
  sourceColorMap,
  grantFilter,
}: {
  panel: PersonPanel;
  sourceList: string[];
  sourceColorMap: Map<string, string>;
  grantFilter: GrantFilter;
}) {
  // Build chart data: each month row has a key per source
  const chartData = panel.months.map((m) => {
    const row: Record<string, string | number> = {
      month: fmtMonth(m.month),
    };
    for (const s of m.sources) {
      row[s.source] = Math.round(s.amount * 100) / 100;
    }
    return row;
  });

  // Filter out months with no data at all (for cleaner charts)
  // Keep months that have either funded data or are within a reasonable range
  const hasAnyData = chartData.some(
    (d) => Object.keys(d).some((k) => k !== "month" && (d[k] as number) > 0)
  );

  const yMax = panel.monthlyCost * 1.1 || 5000;
  const isTotal = panel.person === "Total";

  return (
    <Card className={isTotal ? "border-green-300 dark:border-green-800" : ""}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          {isTotal ? "Total — Todos los Empleados" : panel.person}
          <span className="text-sm font-normal text-muted-foreground">
            (Costo mensual: {fmtCurrency(panel.monthlyCost)})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!hasAnyData ? (
          <div className="h-[300px] flex items-center justify-center text-muted-foreground text-sm">
            Sin datos de financiamiento{grantFilter !== "all" ? ` (filtro: ${grantFilter})` : ""}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={fmtCurrency}
                tick={{ fontSize: 11 }}
                width={70}
                domain={[0, yMax]}
              />
              <Tooltip
                formatter={(v: number | undefined) => fmtCurrency(v ?? 0)}
                labelStyle={{ fontWeight: 600 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine
                y={panel.monthlyCost}
                stroke="#000"
                strokeWidth={2}
                strokeDasharray="8 4"
                label={{
                  value: `Costo: ${fmtCurrency(panel.monthlyCost)}`,
                  position: "right",
                  fill: "#000",
                  fontSize: 11,
                }}
              />
              {sourceList.map((source) => (
                <Bar
                  key={source}
                  dataKey={source}
                  stackId="funding"
                  fill={sourceColorMap.get(source) || "#94a3b8"}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
