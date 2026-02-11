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
    <div className="grid gap-4 md:grid-cols-3">
      {/* Runway with cash on hand */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Reservas Actuales
              </p>
              <p className="text-2xl font-bold mt-1">
                {runwayOnHandMonths} meses
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Saldo: {fmt(lastBankBalance)}
              </p>
            </div>
            <div className="rounded-md bg-blue-100 p-2 dark:bg-blue-900/30">
              <Clock className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Runway with projected income */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Con Ingresos Proyectados
              </p>
              <p className="text-2xl font-bold mt-1">
                {runwayProjectedMonths !== null
                  ? `${runwayProjectedMonths} meses`
                  : "Sin fecha negativa"}
              </p>
              {goingNegativeDate && (
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 text-amber-500" />
                  Negativo en: {goingNegativeDate.slice(0, 7)}
                </p>
              )}
            </div>
            <div className="rounded-md bg-green-100 p-2 dark:bg-green-900/30">
              <TrendingDown className="h-5 w-5 text-green-600 dark:text-green-400" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Annual operating expenses */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Gastos Operativos Anuales
              </p>
              <p className="text-2xl font-bold mt-1">
                {fmt(annualOperatingExpenses)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Excluye terreno, construcción, préstamo
              </p>
            </div>
            <div className="rounded-md bg-red-100 p-2 dark:bg-red-900/30">
              <DollarSign className="h-5 w-5 text-red-600 dark:text-red-400" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
