"use client";

import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DollarSign,
  TrendingDown,
  Clock,
  AlertTriangle,
  Info,
} from "lucide-react";

interface CashflowMetrics {
  lastBankBalance: number;
  annualOperatingExpenses: number;
  totalBudget: number;
  excludedCategories: { category: string; label: string; amount: number }[];
  runwayOnHandMonths: number;
  runwayProjectedMonths: number | null;
  goingNegativeDate: string | null;
}

function fmt(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function MetricsRow({ metrics }: { metrics: CashflowMetrics }) {
  const {
    lastBankBalance,
    annualOperatingExpenses,
    totalBudget,
    excludedCategories,
    runwayOnHandMonths,
    runwayProjectedMonths,
    goingNegativeDate,
  } = metrics;

  const excludedTotal = excludedCategories.reduce((s, e) => s + e.amount, 0);
  // e.g. "compra de vehículos, pago de préstamos"
  const excludedLabels =
    excludedCategories.length > 0
      ? excludedCategories.map((e) => e.label).join(", ")
      : "—";

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {/* Runway with cash on hand */}
      <Card className="py-4 gap-1">
        <CardContent className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Reservas Actuales
            </p>
            <p className="text-xl font-bold mt-0.5">{runwayOnHandMonths} meses</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Saldo: {fmt(lastBankBalance)}
            </p>
          </div>
          <Clock className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
        </CardContent>
      </Card>

      {/* Runway with projected income */}
      <Card className="py-4 gap-1">
        <CardContent className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Con Ingresos Proyectados
            </p>
            <p className="text-xl font-bold mt-0.5">
              {runwayProjectedMonths !== null
                ? `${runwayProjectedMonths} meses`
                : "Sin fecha negativa"}
            </p>
            {goingNegativeDate && (
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-amber-500" />
                Negativo en: {goingNegativeDate.slice(0, 7)}
              </p>
            )}
          </div>
          <TrendingDown className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
        </CardContent>
      </Card>

      {/* Annual operating expenses */}
      <Card className="py-4 gap-1">
        <CardContent className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Gastos Operativos Anuales
            </p>
            <p className="text-xl font-bold mt-0.5">
              {fmt(annualOperatingExpenses)}
            </p>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="mt-0.5 flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Info className="h-3 w-3 shrink-0" />
                    <span className="truncate">Excluye {excludedLabels}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="font-medium">Cómo se calcula</p>
                  <p className="mt-1">
                    Presupuesto anual total {fmt(totalBudget)} menos gastos de
                    capital / financiamiento (no operativos). Estos se registran
                    como Proyecciones (columna &ldquo;Gastos Adic.&rdquo;), no
                    aquí, para no contarlos dos veces.
                  </p>
                  {excludedCategories.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {excludedCategories.map((e) => (
                        <li key={e.category} className="flex justify-between gap-3">
                          <span className="capitalize">{e.label}</span>
                          <span className="tabular-nums">−{fmt(e.amount)}</span>
                        </li>
                      ))}
                      <li className="flex justify-between gap-3 border-t border-background/30 pt-0.5 font-medium">
                        <span>Total excluido</span>
                        <span className="tabular-nums">−{fmt(excludedTotal)}</span>
                      </li>
                    </ul>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <DollarSign className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        </CardContent>
      </Card>
    </div>
  );
}
