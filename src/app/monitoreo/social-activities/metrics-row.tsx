"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarDays, Users, UserRound, Building2, TrendingUp } from "lucide-react";
import type { SocialActivityMetrics } from "@/lib/odk-types";

export function MetricsRow({ metrics }: { metrics: SocialActivityMetrics }) {
  const items = [
    {
      label: "Total de Eventos",
      value: metrics.totalEventos.toLocaleString(),
      icon: CalendarDays,
      color: "text-blue-600",
    },
    {
      label: "Total de Participantes",
      value: metrics.totalParticipantes.toLocaleString(),
      icon: Users,
      color: "text-emerald-600",
    },
    {
      label: "Mujeres",
      value: `${metrics.totalMujeres.toLocaleString()} (${metrics.porcentajeMujeres}%)`,
      icon: UserRound,
      color: "text-purple-600",
    },
    {
      label: "Comunidades Alcanzadas",
      value: metrics.comunidadesAlcanzadas.toLocaleString(),
      icon: Building2,
      color: "text-amber-600",
    },
    {
      label: "Promedio por Evento",
      value: metrics.promedioParticipantes.toLocaleString(),
      icon: TrendingUp,
      color: "text-rose-600",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
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
