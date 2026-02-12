"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Thermometer, Droplets, CloudRain, Calendar } from "lucide-react";
import type { ClimateSummary } from "./actions";

export function MetricsRow({ summary }: { summary: ClimateSummary }) {
  const items = [
    {
      label: "Últimos datos",
      value: summary.latestTimestamp
        ? summary.latestTimestamp.slice(0, 10)
        : "Sin datos",
      icon: Calendar,
      color: "text-slate-600",
    },
    {
      label: "Temperatura",
      value: summary.airTempAvg !== null
        ? `${summary.airTempAvg}°C`
        : "--",
      subtitle: summary.airTempMin !== null && summary.airTempMax !== null
        ? `${summary.airTempMin}° – ${summary.airTempMax}°`
        : undefined,
      icon: Thermometer,
      color: "text-orange-600",
    },
    {
      label: "Precipitación",
      value: summary.totalRainMm !== null
        ? `${summary.totalRainMm} mm`
        : "--",
      icon: CloudRain,
      color: "text-blue-600",
    },
    {
      label: "Humedad",
      value: summary.humidityAvg !== null
        ? `${summary.humidityAvg}%`
        : "--",
      icon: Droplets,
      color: "text-cyan-600",
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
            {item.subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{item.subtitle}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
