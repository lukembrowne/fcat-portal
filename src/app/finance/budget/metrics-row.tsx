"use client";

import { Card, CardHeader } from "@/components/ui/card";
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
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {/* Total Spent */}
      <Card>
        <CardHeader className="pb-2">
          <p className="text-sm text-muted-foreground">Gastos a la Fecha</p>
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-600" />
            <p className="text-2xl font-bold tabular-nums">
              {formatCurrency(totalSpent)}
            </p>
          </div>
        </CardHeader>
      </Card>

      {/* Prorated Budget */}
      <Card>
        <CardHeader className="pb-2">
          <p className="text-sm text-muted-foreground">
            Presupuesto Prorrateado
          </p>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-blue-600" />
            <p className="text-2xl font-bold tabular-nums">
              {formatCurrency(totalBudgetProrated)}
            </p>
          </div>
        </CardHeader>
      </Card>

      {/* Annual Budget */}
      <Card>
        <CardHeader className="pb-2">
          <p className="text-sm text-muted-foreground">Presupuesto Anual</p>
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-purple-600" />
            <p className="text-2xl font-bold tabular-nums">
              {formatCurrency(totalBudgetAnnual)}
            </p>
          </div>
        </CardHeader>
      </Card>

      {/* Over/Under Indicator */}
      {isOverBudget ? (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950">
          <CardHeader className="pb-2">
            <p className="text-sm text-red-700 dark:text-red-400">
              Sobre Presupuesto
            </p>
            <div className="flex items-center gap-2">
              <ThumbsDown className="h-5 w-5 text-red-600" />
              <p className="text-2xl font-bold tabular-nums text-red-700 dark:text-red-400">
                {formatCurrency(overUnderAmount)}
              </p>
            </div>
          </CardHeader>
        </Card>
      ) : (
        <Card className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950">
          <CardHeader className="pb-2">
            <p className="text-sm text-green-700 dark:text-green-400">
              Bajo Presupuesto
            </p>
            <div className="flex items-center gap-2">
              <ThumbsUp className="h-5 w-5 text-green-600" />
              <p className="text-2xl font-bold tabular-nums text-green-700 dark:text-green-400">
                {formatCurrency(overUnderAmount)}
              </p>
            </div>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
