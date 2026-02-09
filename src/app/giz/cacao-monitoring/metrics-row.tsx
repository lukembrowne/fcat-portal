"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MapPin, Sprout, Heart, Users, Leaf } from "lucide-react";
import type { CacaoMetrics } from "@/lib/odk-types";

export function MetricsRow({ metrics }: { metrics: CacaoMetrics }) {
  const items = [
    {
      label: "Fincas Monitoreadas",
      value: metrics.totalFarms.toLocaleString(),
      icon: MapPin,
      color: "text-blue-600",
    },
    {
      label: "Total Plantas",
      value: metrics.totalPlants.toLocaleString(),
      icon: Sprout,
      color: "text-green-600",
    },
    {
      label: "Plantas Vivas",
      value: metrics.plantsAlive.toLocaleString(),
      icon: Leaf,
      color: "text-emerald-600",
    },
    {
      label: "Supervivencia Prom.",
      value: `${metrics.avgSurvivalRate}%`,
      icon: Heart,
      color: "text-rose-600",
    },
    {
      label: "Comunidades",
      value: metrics.communities.toLocaleString(),
      icon: Users,
      color: "text-purple-600",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
