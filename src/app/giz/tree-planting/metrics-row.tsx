"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Trees, Leaf, MapPin, Heart } from "lucide-react";
import type { TreeDashboardMetrics } from "@/lib/odk-types";

export function MetricsRow({ metrics }: { metrics: TreeDashboardMetrics }) {
  const items = [
    {
      label: "Total Árboles",
      value: metrics.totalTrees.toLocaleString(),
      icon: Trees,
      color: "text-green-600",
    },
    {
      label: "Especies",
      value: metrics.uniqueSpecies.toLocaleString(),
      icon: Leaf,
      color: "text-emerald-600",
    },
    {
      label: "Fincas",
      value: metrics.uniqueFarms.toLocaleString(),
      icon: MapPin,
      color: "text-blue-600",
    },
    {
      label: "Supervivencia",
      value: `${metrics.survivalRate}%`,
      icon: Heart,
      color: "text-rose-600",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
