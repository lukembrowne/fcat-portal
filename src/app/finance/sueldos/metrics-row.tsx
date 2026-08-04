"use client";

/**
 * The four planning metrics plus the ledger metric.
 *
 * The two answer different questions from different filters, and the labels say
 * so: the planning figures follow the YEAR selector, the ledger figure follows
 * the layout's date range. Without that distinction the two dollar amounts on
 * one screen read as contradicting each other.
 */

import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, Wallet, TriangleAlert, PieChart } from "lucide-react";
import { formatMoney, formatPercent } from "@/lib/finance/sueldos-fields";
import type { Coverage } from "../lib/sueldos-planning";

function Metric({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
  tone?: string;
}) {
  return (
    <Card className="py-4 gap-1">
      <CardContent className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className={`mt-0.5 text-xl font-bold tabular-nums ${tone ?? ""}`}>{value}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
        <span className="shrink-0">{icon}</span>
      </CardContent>
    </Card>
  );
}

export function MetricsRow({
  total,
  totalSpent,
  year,
}: {
  total: Coverage;
  totalSpent: number;
  year: number;
}) {
  const overFunded = total.state === "over";

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Metric
        label="Costo total de sueldos"
        value={formatMoney(total.cost)}
        hint={`Planificado para ${year}`}
        icon={<Wallet className="h-4 w-4 text-muted-foreground" />}
      />
      <Metric
        label="Financiado"
        value={formatMoney(total.funded)}
        hint={`Asignado a ${year}`}
        icon={<DollarSign className="h-4 w-4 text-green-600 dark:text-green-400" />}
      />
      <Metric
        label={overFunded ? "Sobrefinanciado" : "Sin cubrir"}
        value={formatMoney(overFunded ? total.overfunded : total.uncovered)}
        hint={overFunded ? `Excedente en ${year}` : `Falta cubrir en ${year}`}
        icon={
          <TriangleAlert
            className={`h-4 w-4 ${overFunded ? "text-amber-600" : "text-red-600 dark:text-red-400"}`}
          />
        }
        tone={
          overFunded
            ? "text-amber-700 dark:text-amber-500"
            : total.uncovered > 0
              ? "text-red-600 dark:text-red-400"
              : ""
        }
      />
      <Metric
        label="% cubierto"
        value={total.cost > 0 ? formatPercent(total.percentCovered) : "—"}
        hint={`Del costo de ${year}`}
        icon={<PieChart className="h-4 w-4 text-muted-foreground" />}
      />
      <Metric
        label="Gastado en sueldos"
        value={formatMoney(totalSpent)}
        hint="Libro mayor · período seleccionado arriba"
        icon={<DollarSign className="h-4 w-4 text-muted-foreground" />}
      />
    </div>
  );
}
