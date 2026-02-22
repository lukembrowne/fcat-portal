"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  Legend,
} from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SocialActivityRecord } from "@/lib/odk-types";
import {
  TIPO_EVENTO_LABELS,
  AREA_DESARROLLO_LABELS,
  PROYECTO_FCAT_LABELS,
} from "./labels";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function HorizontalBarChart({
  data,
  title,
}: {
  data: { name: string; count: number }[];
  title: string;
}) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Sin datos</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer
          width="100%"
          height={Math.max(250, data.length * 36)}
        >
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
          >
            <XAxis type="number" />
            <YAxis
              type="category"
              dataKey="name"
              width={160}
              tick={{ fontSize: 12 }}
            />
            <Tooltip />
            <Bar dataKey="count" radius={[0, 4, 4, 0]}>
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function ActivityCharts({
  activities,
}: {
  activities: SocialActivityRecord[];
}) {
  const byMonth = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of activities) {
      if (a.fecha) {
        const month = a.fecha.substring(0, 7); // YYYY-MM
        counts[month] = (counts[month] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([month, count]) => ({ name: month, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [activities]);

  const byTipoEvento = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of activities) {
      if (a.tipoEvento) {
        const label = TIPO_EVENTO_LABELS[a.tipoEvento] ?? a.tipoEvento;
        counts[label] = (counts[label] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [activities]);

  const byArea = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of activities) {
      for (const area of a.areasDesarrollo) {
        const label = AREA_DESARROLLO_LABELS[area] ?? area;
        counts[label] = (counts[label] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [activities]);

  const byProyecto = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of activities) {
      for (const p of a.proyectosFcat) {
        const label = PROYECTO_FCAT_LABELS[p] ?? p;
        counts[label] = (counts[label] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [activities]);

  const demographics = useMemo(() => {
    const totals = { Mujeres: 0, Hombres: 0, "Niños": 0, Adolescentes: 0 };
    for (const a of activities) {
      totals.Mujeres += a.numMujeres;
      totals.Hombres += a.numHombres;
      totals["Niños"] += a.numNinos;
      totals.Adolescentes += a.numAdolescentes;
    }
    return Object.entries(totals)
      .map(([name, count]) => ({ name, count }))
      .filter((d) => d.count > 0);
  }, [activities]);

  return (
    <Tabs defaultValue="monthly">
      <TabsList className="flex-wrap h-auto gap-1">
        <TabsTrigger value="monthly">Eventos por Mes</TabsTrigger>
        <TabsTrigger value="tipo">Por Tipo</TabsTrigger>
        <TabsTrigger value="area">Áreas</TabsTrigger>
        <TabsTrigger value="demographics">Demografía</TabsTrigger>
        <TabsTrigger value="proyecto">Proyectos</TabsTrigger>
      </TabsList>

      <TabsContent value="monthly">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Eventos por Mes</CardTitle>
          </CardHeader>
          <CardContent>
            {byMonth.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin datos</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart
                  data={byMonth}
                  margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
                >
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="tipo">
        <HorizontalBarChart data={byTipoEvento} title="Eventos por Tipo" />
      </TabsContent>

      <TabsContent value="area">
        <HorizontalBarChart data={byArea} title="Eventos por Área de Desarrollo" />
      </TabsContent>

      <TabsContent value="demographics">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Desglose Demográfico</CardTitle>
          </CardHeader>
          <CardContent>
            {demographics.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin datos</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart
                  data={demographics}
                  margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
                >
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="count" name="Participantes" radius={[4, 4, 0, 0]}>
                    {demographics.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="proyecto">
        <HorizontalBarChart data={byProyecto} title="Eventos por Proyecto FCAT" />
      </TabsContent>
    </Tabs>
  );
}
