"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Thermometer, Droplets, CloudRain, Calendar, Sun, Wind, Gauge } from "lucide-react";
import type { ClimateSummary } from "./actions";

interface MetricItem {
  label: string;
  value: string;
  description: string;
  subtitle?: string;
  icon: typeof Calendar;
  color: string;
}

export function MetricsRow({ summary }: { summary: ClimateSummary }) {
  const items: MetricItem[] = [
    {
      label: "Últimos datos",
      value: summary.latestTimestamp
        ? summary.latestTimestamp.slice(0, 10)
        : "Sin datos",
      description: "Marca de tiempo del último registro en el período",
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
      description: "Promedio del período (air_temp_avg), rango de min a max",
      icon: Thermometer,
      color: "text-orange-600",
    },
    {
      label: "Precipitación",
      value: summary.totalRainMm !== null
        ? `${summary.totalRainMm} mm`
        : "--",
      description: "Total acumulado del período (rain_mm)",
      icon: CloudRain,
      color: "text-blue-600",
    },
    {
      label: "Humedad",
      value: summary.humidityAvg !== null
        ? `${summary.humidityAvg}%`
        : "--",
      description: "Promedio del período (humidity_avg)",
      icon: Droplets,
      color: "text-cyan-600",
    },
    {
      label: "Radiación Solar",
      value: summary.solarAvg !== null
        ? `${summary.solarAvg} W/m²`
        : "--",
      description: "Promedio del período (solar_avg)",
      icon: Sun,
      color: "text-yellow-600",
    },
    {
      label: "Viento",
      value: summary.windSpeedAvg !== null
        ? `${summary.windSpeedAvg} m/s`
        : "--",
      description: "Velocidad promedio del período (wind_speed_avg)",
      icon: Wind,
      color: "text-emerald-600",
    },
    {
      label: "Presión",
      value: summary.pressureAvg !== null
        ? `${summary.pressureAvg} hPa`
        : "--",
      description: "Promedio del período (pressure_avg)",
      icon: Gauge,
      color: "text-violet-600",
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-4">
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
            <p className="text-[11px] text-muted-foreground/70 mt-1 leading-tight">
              {item.description}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
