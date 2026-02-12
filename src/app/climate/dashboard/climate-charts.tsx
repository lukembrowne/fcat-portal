"use client";

import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ChartDataPoint } from "./actions";
import type { AggregationLevel } from "./actions";

interface ClimateChartsProps {
  data: ChartDataPoint[];
  aggregation: string;
}

function formatTimestamp(ts: string): string {
  // For monthly: "2025-03" → "Mar 25"
  if (ts.length === 7) {
    const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    const m = parseInt(ts.slice(5, 7), 10) - 1;
    return `${months[m]} ${ts.slice(2, 4)}`;
  }
  // For daily: "2025-03-01" → "01 Mar"
  if (ts.length === 10) {
    const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    const m = parseInt(ts.slice(5, 7), 10) - 1;
    return `${ts.slice(8, 10)} ${months[m]}`;
  }
  // For raw: "2025-03-01 11:00:00" → "01 Mar 11:00"
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const m = parseInt(ts.slice(5, 7), 10) - 1;
  return `${ts.slice(8, 10)} ${months[m]} ${ts.slice(11, 16)}`;
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={320}>
          {children as React.ReactElement}
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function ClimateCharts({ data, aggregation }: ClimateChartsProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed p-12 text-muted-foreground">
        No hay datos para el período seleccionado
      </div>
    );
  }

  const chartData = data.map((d) => ({
    ...d,
    label: formatTimestamp(d.timestamp),
  }));

  const isAggregated = aggregation !== "raw";

  return (
    <Tabs defaultValue="temperatura">
      <TabsList className="mb-4">
        <TabsTrigger value="temperatura">Temperatura</TabsTrigger>
        <TabsTrigger value="humedad">Humedad</TabsTrigger>
        <TabsTrigger value="precipitacion">Precipitación</TabsTrigger>
        <TabsTrigger value="solar">Radiación Solar</TabsTrigger>
        <TabsTrigger value="viento">Viento</TabsTrigger>
        <TabsTrigger value="presion">Presión</TabsTrigger>
      </TabsList>

      <TabsContent value="temperatura">
        <ChartCard title="Temperatura (°C)">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="airTempMax" name="Máx" stroke="var(--chart-1, #ef4444)" dot={false} connectNulls={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="airTempAvg" name="Prom" stroke="var(--chart-2, #f97316)" dot={false} connectNulls={false} strokeWidth={2} />
            <Line type="monotone" dataKey="airTempMin" name="Mín" stroke="var(--chart-3, #3b82f6)" dot={false} connectNulls={false} strokeWidth={1.5} />
          </LineChart>
        </ChartCard>
      </TabsContent>

      <TabsContent value="humedad">
        <ChartCard title="Humedad Relativa (%)">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="humidityMax" name="Máx" stroke="var(--chart-1, #ef4444)" dot={false} connectNulls={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="humidityAvg" name="Prom" stroke="var(--chart-4, #06b6d4)" dot={false} connectNulls={false} strokeWidth={2} />
            <Line type="monotone" dataKey="humidityMin" name="Mín" stroke="var(--chart-3, #3b82f6)" dot={false} connectNulls={false} strokeWidth={1.5} />
          </LineChart>
        </ChartCard>
      </TabsContent>

      <TabsContent value="precipitacion">
        <ChartCard title="Precipitación (mm)">
          <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="rainMm" name="Precipitación" fill="var(--chart-3, #3b82f6)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ChartCard>
      </TabsContent>

      <TabsContent value="solar">
        <ChartCard title="Radiación Solar (W/m²)">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="solarMax" name="Máx" stroke="var(--chart-1, #ef4444)" dot={false} connectNulls={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="solarAvg" name="Prom" stroke="var(--chart-5, #eab308)" dot={false} connectNulls={false} strokeWidth={2} />
            <Line type="monotone" dataKey="solarMin" name="Mín" stroke="var(--chart-3, #3b82f6)" dot={false} connectNulls={false} strokeWidth={1.5} />
          </LineChart>
        </ChartCard>
      </TabsContent>

      <TabsContent value="viento">
        <div className="space-y-4">
          <ChartCard title="Velocidad del Viento (m/s)">
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="windSpeedMax" name="Máx" stroke="var(--chart-1, #ef4444)" dot={false} connectNulls={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="windSpeedAvg" name="Prom" stroke="var(--chart-2, #f97316)" dot={false} connectNulls={false} strokeWidth={2} />
            </LineChart>
          </ChartCard>

          {!isAggregated ? (
            <ChartCard title="Dirección del Viento (grados)">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11 }} domain={[0, 360]} />
                <Tooltip />
                <Line type="monotone" dataKey="windDirAvg" name="Dir Prom" stroke="var(--chart-4, #06b6d4)" dot={false} connectNulls={false} strokeWidth={1.5} />
              </LineChart>
            </ChartCard>
          ) : (
            <Card>
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                La dirección del viento no se agrega (datos circulares). Seleccione un período de 90 días o menos para ver la dirección.
              </CardContent>
            </Card>
          )}
        </div>
      </TabsContent>

      <TabsContent value="presion">
        <ChartCard title="Presión Atmosférica">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="pressureMax" name="Máx" stroke="var(--chart-1, #ef4444)" dot={false} connectNulls={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="pressureAvg" name="Prom" stroke="var(--chart-2, #f97316)" dot={false} connectNulls={false} strokeWidth={2} />
            <Line type="monotone" dataKey="pressureMin" name="Mín" stroke="var(--chart-3, #3b82f6)" dot={false} connectNulls={false} strokeWidth={1.5} />
          </LineChart>
        </ChartCard>
      </TabsContent>
    </Tabs>
  );
}
