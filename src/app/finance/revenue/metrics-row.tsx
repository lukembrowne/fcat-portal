"use client";

import { Card, CardHeader } from "@/components/ui/card";
import { DollarSign } from "lucide-react";

export function MetricsRow({ totalRevenue }: { totalRevenue: string }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <p className="text-sm text-muted-foreground">Total Ingresos</p>
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-600" />
            <p className="text-2xl font-bold tabular-nums">{totalRevenue}</p>
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}
