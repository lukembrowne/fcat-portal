"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Calendar, Hash } from "lucide-react";
import type { IbuttonStatus } from "./types";

interface MetricItem {
  label: string;
  value: string;
  subtitle?: string;
  icon: typeof Calendar;
  color: string;
}

export function SummaryCards({ status }: { status: IbuttonStatus | null }) {
  if (!status) return null;

  const items: MetricItem[] = [
    {
      label: "Despliegues procesados",
      value: `${status.processed} / ${status.total}`,
      subtitle: status.unprocessed > 0
        ? `${status.unprocessed} pendientes`
        : "Todo procesado",
      icon: BarChart3,
      color: "text-blue-600",
    },
    {
      label: "Lecturas totales",
      value: status.totalReadings.toLocaleString("es"),
      icon: Hash,
      color: "text-emerald-600",
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {items.map((item) => (
        <Card key={item.label} className="py-4">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {item.label}
            </CardTitle>
            <item.icon className={`h-4 w-4 ${item.color}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{item.value}</div>
            {item.subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {item.subtitle}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
