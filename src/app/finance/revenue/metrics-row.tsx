"use client";

import { Card, CardContent } from "@/components/ui/card";
import { DollarSign } from "lucide-react";

export function MetricsRow({ totalRevenue }: { totalRevenue: string }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
      <Card className="py-4 gap-1">
        <CardContent className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Total Ingresos
            </p>
            <p className="text-xl font-bold tabular-nums mt-0.5">
              {totalRevenue}
            </p>
          </div>
          <DollarSign className="h-4 w-4 shrink-0 text-green-600" />
        </CardContent>
      </Card>
    </div>
  );
}
