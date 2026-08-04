"use client";

/**
 * Monthly funding coverage per person and per group.
 *
 * These keep their own horizon (current year → +2 years) rather than following
 * the year selector: the tables answer "is 2026 covered", the charts answer
 * "when does funding run out", and bounding them to one year would destroy the
 * second question.
 *
 * The cost line is a STEP function drawn from per-month data rather than a flat
 * ReferenceLine, so a salary that changes between years shows the change instead
 * of averaging it away.
 */

import { useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney0 } from "@/lib/finance/sueldos-fields";
import type { ChartPanel } from "./actions";

/** Stable per-source palette. Keyed by source ID, not by sorted position, so
 *  renaming a source doesn't shuffle every colour on the page. */
const SOURCE_COLORS = [
  "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#ec4899", "#14b8a6", "#f97316", "#6366f1",
  "#84cc16", "#a855f7", "#d946ef", "#0ea5e9", "#10b981",
];

const COST_LINE_KEY = "__costo";

const MONTHS_ES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

function fmtMonth(ym: string): string {
  const m = parseInt(ym.slice(5, 7), 10) - 1;
  return `${MONTHS_ES[m]} ${ym.slice(2, 4)}`;
}

export function SueldosCharts({ panels }: { panels: ChartPanel[] }) {
  const [open, setOpen] = useState(true);

  if (panels.length === 0) return null;

  // Every source that appears anywhere, so colours and legend stay consistent
  // across panels.
  const sourceNameById = new Map<number, string>();
  for (const p of panels) {
    for (const m of p.months) {
      for (const s of m.sources) sourceNameById.set(s.sourceId, s.source);
    }
  }
  const sourceIds = Array.from(sourceNameById.keys()).sort((a, b) => a - b);
  const colorById = new Map(
    sourceIds.map((id, i) => [id, SOURCE_COLORS[i % SOURCE_COLORS.length]])
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 text-left"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <CardTitle className="text-base">Cobertura mensual</CardTitle>
          <span className="text-sm font-normal text-muted-foreground">
            (año actual y los dos siguientes)
          </span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-6">
          {panels.map((panel) => (
            <PanelChart
              key={panel.key}
              panel={panel}
              sourceIds={sourceIds}
              sourceNameById={sourceNameById}
              colorById={colorById}
            />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function PanelChart({
  panel,
  sourceIds,
  sourceNameById,
  colorById,
}: {
  panel: ChartPanel;
  sourceIds: number[];
  sourceNameById: Map<number, string>;
  colorById: Map<number, string>;
}) {
  // One row per month: a key per source (by NAME, so the legend and tooltip read
  // properly) plus the step-line cost.
  const data = panel.months.map((m) => {
    const row: Record<string, string | number | null> = { month: fmtMonth(m.month) };
    for (const s of m.sources) {
      row[sourceNameById.get(s.sourceId) ?? String(s.sourceId)] =
        Math.round(s.amount * 100) / 100;
    }
    row[COST_LINE_KEY] = m.monthlyCost == null ? null : Math.round(m.monthlyCost * 100) / 100;
    return row;
  });

  const hasFunding = panel.months.some((m) => m.totalFunded > 0);
  const hasCost = panel.months.some((m) => m.monthlyCost != null && m.monthlyCost > 0);

  if (!hasFunding && !hasCost) return null;

  const peakCost = Math.max(...panel.months.map((m) => m.monthlyCost ?? 0));
  const peakFunded = Math.max(...panel.months.map((m) => m.totalFunded));
  const yMax = Math.max(peakCost, peakFunded) * 1.1 || 5000;

  const isTotal = panel.key === "total";

  return (
    <div>
      <p className={`mb-1 text-sm ${isTotal ? "font-semibold" : "font-medium"}`}>{panel.label}</p>
      <ResponsiveContainer width="100%" height={isTotal ? 320 : 240}>
        <ComposedChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis
            tickFormatter={formatMoney0}
            tick={{ fontSize: 11 }}
            width={70}
            domain={[0, yMax]}
          />
          <Tooltip
            formatter={(value, name) => [
              formatMoney0(typeof value === "number" ? value : 0),
              name === COST_LINE_KEY ? "Costo mensual" : String(name),
            ]}
            labelStyle={{ fontWeight: 600 }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            formatter={(name) => (name === COST_LINE_KEY ? "Costo mensual" : name)}
          />
          {sourceIds.map((id) => (
            <Bar
              key={id}
              dataKey={sourceNameById.get(id) ?? String(id)}
              stackId="funding"
              fill={colorById.get(id) ?? "#94a3b8"}
            />
          ))}
          <Line
            type="stepAfter"
            dataKey={COST_LINE_KEY}
            stroke="currentColor"
            className="text-foreground"
            strokeWidth={2}
            strokeDasharray="8 4"
            dot={false}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
