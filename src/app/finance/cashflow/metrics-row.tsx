"use client";

import { Card, CardContent } from "@/components/ui/card";
import {
  DollarSign,
  TrendingDown,
  Clock,
  AlertTriangle,
} from "lucide-react";

interface CashflowMetrics {
  lastBankBalance: number;
  annualOperatingExpenses: number;
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
    runwayOnHandMonths,
    runwayProjectedMonths,
    goingNegativeDate,
  } = metrics;

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
            <p className="text-xs text-muted-foreground mt-0.5">
              Excluye terreno, construcción, préstamo
            </p>
          </div>
          <DollarSign className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        </CardContent>
      </Card>
    </div>
  );
}
