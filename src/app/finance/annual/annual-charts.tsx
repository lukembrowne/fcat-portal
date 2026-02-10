"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  AnnualSummaryRow,
  MonthlyByYear,
  CategoryByYear,
} from "./actions";

const MONTH_NAMES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

const YEAR_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "#8884d8",
  "#82ca9d",
  "#ffc658",
  "#ff7300",
  "#a4de6c",
];

function formatCurrency(val: number) {
  return "$" + val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tooltipFormatter(value: any) {
  return formatCurrency(Number(value));
}

interface Props {
  annualSummary: AnnualSummaryRow[];
  monthlyRevenue: MonthlyByYear[];
  monthlyExpenses: MonthlyByYear[];
  expensesByCategory: CategoryByYear[];
}

export function AnnualCharts({
  annualSummary,
  monthlyRevenue,
  monthlyExpenses,
  expensesByCategory,
}: Props) {
  // --- Annual Summary chart data ---
  const summaryData = useMemo(
    () =>
      annualSummary.map((row) => ({
        year: String(row.year),
        Ingresos: row.totalRevenue,
        Gastos: row.totalExpenses,
      })),
    [annualSummary]
  );

  // --- Monthly Revenue comparison data ---
  const years = useMemo(
    () => [...new Set(annualSummary.map((r) => r.year))].sort((a, b) => a - b),
    [annualSummary]
  );

  const monthlyRevenueData = useMemo(() => {
    // Build: [{ month: "Ene", "2023": 1000, "2024": 1200 }, ...]
    const byMonthYear = new Map<string, Record<string, number>>();
    for (let m = 1; m <= 12; m++) {
      const key = MONTH_NAMES[m - 1];
      const row: Record<string, number> = {};
      for (const y of years) row[String(y)] = 0;
      byMonthYear.set(key, row);
    }
    for (const entry of monthlyRevenue) {
      const key = MONTH_NAMES[entry.month - 1];
      const row = byMonthYear.get(key);
      if (row) row[String(entry.year)] = entry.amount;
    }
    return Array.from(byMonthYear.entries()).map(([month, vals]) => ({
      month,
      ...vals,
    }));
  }, [monthlyRevenue, years]);

  // --- Monthly Expenses comparison data ---
  const monthlyExpensesData = useMemo(() => {
    const byMonthYear = new Map<string, Record<string, number>>();
    for (let m = 1; m <= 12; m++) {
      const key = MONTH_NAMES[m - 1];
      const row: Record<string, number> = {};
      for (const y of years) row[String(y)] = 0;
      byMonthYear.set(key, row);
    }
    for (const entry of monthlyExpenses) {
      const key = MONTH_NAMES[entry.month - 1];
      const row = byMonthYear.get(key);
      if (row) row[String(entry.year)] = entry.amount;
    }
    return Array.from(byMonthYear.entries()).map(([month, vals]) => ({
      month,
      ...vals,
    }));
  }, [monthlyExpenses, years]);

  // --- Expenses by Category comparison data ---
  const categoryData = useMemo(() => {
    // Get top categories across all years (by total amount)
    const categoryTotals = new Map<string, number>();
    for (const entry of expensesByCategory) {
      categoryTotals.set(
        entry.category,
        (categoryTotals.get(entry.category) ?? 0) + entry.amount
      );
    }
    const topCategories = [...categoryTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([cat]) => cat);

    const byCatYear = new Map<string, Record<string, number>>();
    for (const cat of topCategories) {
      const row: Record<string, number> = {};
      for (const y of years) row[String(y)] = 0;
      byCatYear.set(cat, row);
    }
    for (const entry of expensesByCategory) {
      const row = byCatYear.get(entry.category);
      if (row) row[String(entry.year)] = entry.amount;
    }
    return Array.from(byCatYear.entries()).map(([category, vals]) => ({
      category,
      ...vals,
    }));
  }, [expensesByCategory, years]);

  if (annualSummary.length === 0) {
    return (
      <Card>
        <CardContent className="py-8">
          <p className="text-sm text-muted-foreground text-center">
            Sin datos anuales disponibles
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Annual Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resumen Anual</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={summaryData}>
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={formatCurrency} tick={{ fontSize: 11 }} />
              <Tooltip formatter={tooltipFormatter} />
              <Legend />
              <Bar dataKey="Ingresos" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Gastos" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Monthly Revenue Comparison */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ingresos Mensuales por Ano</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={monthlyRevenueData}>
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={formatCurrency} tick={{ fontSize: 11 }} />
              <Tooltip formatter={tooltipFormatter} />
              <Legend />
              {years.map((y, i) => (
                <Bar
                  key={y}
                  dataKey={String(y)}
                  fill={YEAR_COLORS[i % YEAR_COLORS.length]}
                  radius={[4, 4, 0, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Monthly Expense Comparison */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gastos Mensuales por Ano</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={monthlyExpensesData}>
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={formatCurrency} tick={{ fontSize: 11 }} />
              <Tooltip formatter={tooltipFormatter} />
              <Legend />
              {years.map((y, i) => (
                <Bar
                  key={y}
                  dataKey={String(y)}
                  fill={YEAR_COLORS[i % YEAR_COLORS.length]}
                  radius={[4, 4, 0, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Expenses by Category Comparison */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">
            Gastos por Categoria por Ano (Top 15)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={categoryData} layout="vertical">
              <XAxis
                type="number"
                tickFormatter={formatCurrency}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                type="category"
                dataKey="category"
                tick={{ fontSize: 10 }}
                width={180}
              />
              <Tooltip formatter={tooltipFormatter} />
              <Legend />
              {years.map((y, i) => (
                <Bar
                  key={y}
                  dataKey={String(y)}
                  fill={YEAR_COLORS[i % YEAR_COLORS.length]}
                  radius={[0, 4, 4, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
