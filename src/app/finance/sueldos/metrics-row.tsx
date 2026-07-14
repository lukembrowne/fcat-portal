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
    <div className="grid gap-3 md:grid-cols-2">
      {/* Total salary spend */}
      <Card className="py-4 gap-1">
        <CardContent className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Total Gastado en Sueldos
            </p>
            <p className="text-xl font-bold mt-0.5">{fmt(totalSpent)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              En el período seleccionado
            </p>
          </div>
          <DollarSign className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
        </CardContent>
      </Card>

      {/* Grant status filter */}
      <Card className="py-4 gap-1">
        <CardContent>
          <p className="text-xs font-medium text-muted-foreground mb-2">
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
