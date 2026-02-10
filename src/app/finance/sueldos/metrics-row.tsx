"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign } from "lucide-react";

type GrantFilter = "all" | "funded" | "pending";

const FILTERS: { value: GrantFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "funded", label: "Solo Financiado" },
  { value: "pending", label: "Solo Pendiente" },
];

function fmt(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function MetricsRow({
  totalSpent,
  grantFilter,
  onFilterChange,
}: {
  totalSpent: number;
  grantFilter: GrantFilter;
  onFilterChange: (f: GrantFilter) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Total salary spend */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Total Gastado en Sueldos
              </p>
              <p className="text-2xl font-bold mt-1">{fmt(totalSpent)}</p>
              <p className="text-xs text-muted-foreground mt-1">
                En el período seleccionado
              </p>
            </div>
            <div className="rounded-md bg-green-100 p-2 dark:bg-green-900/30">
              <DollarSign className="h-5 w-5 text-green-600 dark:text-green-400" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Grant status filter */}
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm font-medium text-muted-foreground mb-3">
            Filtro por Estado de Financiamiento
          </p>
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <Button
                key={f.value}
                variant={grantFilter === f.value ? "default" : "outline"}
                size="sm"
                onClick={() => onFilterChange(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
