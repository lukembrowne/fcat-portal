"use client";

import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, TrendingUp, Calendar, ThumbsUp, ThumbsDown } from "lucide-react";

function formatCurrency(val: number) {
  return (
    "$" +
    Math.abs(val).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

interface MetricsRowProps {
  totalSpent: number;
  totalBudgetProrated: number;
  totalBudgetAnnual: number;
  isOverBudget: boolean;
  overUnderAmount: number;
}

export function MetricsRow({
  totalSpent,
  totalBudgetProrated,
  totalBudgetAnnual,
  isOverBudget,
  overUnderAmount,
}: MetricsRowProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
      {/* Total Spent */}
      <Card className="py-4 gap-1">
        <CardContent className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Gastos a la Fecha
            </p>
            <p className="text-xl font-bold tabular-nums mt-0.5">
              {formatCurrency(totalSpent)}
            </p>
          </div>
          <DollarSign className="h-4 w-4 shrink-0 text-green-600" />
        </CardContent>
      </Card>

      {/* Prorated Budget */}
      <Card className="py-4 gap-1">
        <CardContent className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Presupuesto Prorrateado
            </p>
            <p className="text-xl font-bold tabular-nums mt-0.5">
              {formatCurrency(totalBudgetProrated)}
            </p>
          </div>
          <TrendingUp className="h-4 w-4 shrink-0 text-blue-600" />
        </CardContent>
      </Card>

      {/* Annual Budget */}
      <Card className="py-4 gap-1">
        <CardContent className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Presupuesto Anual
            </p>
            <p className="text-xl font-bold tabular-nums mt-0.5">
              {formatCurrency(totalBudgetAnnual)}
            </p>
          </div>
          <Calendar className="h-4 w-4 shrink-0 text-purple-600" />
        </CardContent>
      </Card>

      {/* Over/Under Indicator */}
      {isOverBudget ? (
        <Card className="py-4 gap-1 border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950">
          <CardContent className="flex items-start justify-between">
            <div className="min-w-0">
              <p className="text-xs font-medium text-red-700 dark:text-red-400">
                Sobre Presupuesto
              </p>
              <p className="text-xl font-bold tabular-nums mt-0.5 text-red-700 dark:text-red-400">
                {formatCurrency(overUnderAmount)}
              </p>
            </div>
            <ThumbsDown className="h-4 w-4 shrink-0 text-red-600" />
          </CardContent>
        </Card>
      ) : (
        <Card className="py-4 gap-1 border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950">
          <CardContent className="flex items-start justify-between">
            <div className="min-w-0">
              <p className="text-xs font-medium text-green-700 dark:text-green-400">
                Bajo Presupuesto
              </p>
              <p className="text-xl font-bold tabular-nums mt-0.5 text-green-700 dark:text-green-400">
                {formatCurrency(overUnderAmount)}
              </p>
            </div>
            <ThumbsUp className="h-4 w-4 shrink-0 text-green-600" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
