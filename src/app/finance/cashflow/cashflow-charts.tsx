"use client";

import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CashflowMonthRow, MonthlyAmount } from "../types";

function fmtMonth(ym: string): string {
  // "2025-01-01" → "Ene 25"
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const m = parseInt(ym.slice(5, 7), 10) - 1;
  const y = ym.slice(2, 4);
  return `${months[m]} ${y}`;
}

function fmtCurrency(v: number): string {
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

interface CashflowChartsProps {
  monthRows: CashflowMonthRow[];
  revenueByMonth: MonthlyAmount[];
  expensesByMonth: MonthlyAmount[];
  cashReserveTarget: number;
}

export function CashflowCharts({
  monthRows,
  revenueByMonth,
  expensesByMonth,
  cashReserveTarget,
}: CashflowChartsProps) {
  // Bar chart data: revenue vs expenses + projected
  const revenueMap = new Map(revenueByMonth.map((r) => [r.yearMonth, r.amount]));
  const expensesMap = new Map(expensesByMonth.map((r) => [r.yearMonth, r.amount]));

  const barData = monthRows.map((row) => ({
    month: fmtMonth(row.yearMonth),
    Ingresos: revenueMap.get(row.yearMonth) ?? 0,
    Gastos: expensesMap.get(row.yearMonth) ?? 0,
    "Gastos Proyectados": row.balance === null ? (row.projectedExpenses ?? 0) : 0,
    "Gastos Adicionales": row.balance === null ? (row.projectedAdditionalExpenses ?? 0) : 0,
    "Ingresos Proyectados": row.balance === null ? (row.projectedIncome ?? 0) : 0,
  }));

  // Line chart data: balance + projected balance + reference lines
  const lineData = monthRows.map((row) => ({
    month: fmtMonth(row.yearMonth),
    Saldo: row.balance,
    "Saldo Proyectado": row.projectedBalance,
  }));

  const hasData = monthRows.length > 0;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Revenue vs Expenses Bar Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Ingresos vs Gastos por Mes</CardTitle>
        </CardHeader>
        <CardContent>
          {hasData ? (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={barData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickFormatter={fmtCurrency}
                  tick={{ fontSize: 11 }}
                  width={70}
                />
                <Tooltip
                  formatter={(v: number | undefined) => fmtCurrency(v ?? 0)}
                  labelStyle={{ fontWeight: 600 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Ingresos" fill="#22c55e" stackId="income" />
                <Bar dataKey="Ingresos Proyectados" fill="rgba(34,197,94,0.4)" stackId="income" />
                <Bar dataKey="Gastos" fill="#ef4444" stackId="expense" />
                <Bar dataKey="Gastos Proyectados" fill="rgba(239,68,68,0.4)" stackId="expense" />
                <Bar dataKey="Gastos Adicionales" fill="rgba(239,68,68,0.25)" stackId="expense" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[320px] flex items-center justify-center text-muted-foreground text-sm">
              Sin datos — cargue el Libro Mayor primero
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cash Balance Line Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Balance de Caja</CardTitle>
        </CardHeader>
        <CardContent>
          {hasData ? (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={lineData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickFormatter={fmtCurrency}
                  tick={{ fontSize: 11 }}
                  width={70}
                />
                <Tooltip
                  formatter={(v: number | undefined) => fmtCurrency(v ?? 0)}
                  labelStyle={{ fontWeight: 600 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <ReferenceLine y={0} stroke="#ef4444" strokeWidth={2} label={{ value: "$0", fill: "#ef4444", fontSize: 11 }} />
                <ReferenceLine
                  y={cashReserveTarget}
                  stroke="#22c55e"
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                  label={{ value: `Meta: ${fmtCurrency(cashReserveTarget)}`, fill: "#22c55e", fontSize: 11 }}
                />
                <Line
                  type="monotone"
                  dataKey="Saldo"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="Saldo Proyectado"
                  stroke="#a855f7"
                  strokeWidth={2}
                  strokeDasharray="8 4"
                  dot={false}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[320px] flex items-center justify-center text-muted-foreground text-sm">
              Sin datos — cargue el Libro Mayor primero
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
