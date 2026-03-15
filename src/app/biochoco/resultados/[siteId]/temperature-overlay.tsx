"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { DeploymentTemperature, SiteDetail } from "../types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Thermometer, ExternalLink } from "lucide-react";

interface TemperatureOverlayProps {
  temperature: DeploymentTemperature[];
  temperatureStats: SiteDetail["temperatureStats"];
}

// Distinct colors for overlaid deployments
const DEPLOYMENT_COLORS = [
  "#f97316", // orange
  "#3b82f6", // blue
  "#22c55e", // green
  "#a855f7", // purple
  "#ef4444", // red
  "#06b6d4", // cyan
  "#f59e0b", // amber
  "#ec4899", // pink
  "#14b8a6", // teal
  "#8b5cf6", // violet
];

const MONTH_NAMES = [
  "", "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

function formatTickLabel(ts: string): string {
  const [datePart] = ts.split(" ");
  if (!datePart) return ts;
  const [, month, day] = datePart.split("-");
  const m = parseInt(month ?? "0", 10);
  return `${day} ${MONTH_NAMES[m] ?? month}`;
}

export function TemperatureOverlay({
  temperature,
  temperatureStats,
}: TemperatureOverlayProps) {
  // Merge all readings into a unified dataset keyed by timestamp
  const { chartData, deploymentKeys } = useMemo(() => {
    if (temperature.length === 0) return { chartData: [], deploymentKeys: [] };

    const keys = temperature.map((d) => d.deploymentName);

    // Collect all unique timestamps and build rows
    const rowMap = new Map<string, Record<string, number | string>>();

    for (const dep of temperature) {
      for (const reading of dep.readings) {
        const row = rowMap.get(reading.timestamp) ?? {
          timestamp: reading.timestamp,
        };
        row[dep.deploymentName] = reading.temperatureC;
        rowMap.set(reading.timestamp, row);
      }
    }

    const sorted = Array.from(rowMap.values()).sort((a, b) =>
      String(a.timestamp).localeCompare(String(b.timestamp))
    );

    return { chartData: sorted, deploymentKeys: keys };
  }, [temperature]);

  // Determine tick interval
  const tickInterval = Math.max(1, Math.floor(chartData.length / 20));

  return (
    <section>
      <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
        <Thermometer className="h-5 w-5" />
        Temperatura
      </h2>

      {temperature.length === 0 ? (
        <div className="flex items-center justify-center h-[200px] bg-muted rounded-xl">
          <p className="text-muted-foreground">
            No hay datos de temperatura para este sitio.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Summary stats */}
          {temperatureStats && (
            <div className="flex flex-wrap gap-4">
              <div className="bg-muted rounded-lg px-4 py-2">
                <p className="text-lg font-bold">{temperatureStats.min.toFixed(1)}°C</p>
                <p className="text-xs text-muted-foreground">Mínima</p>
              </div>
              <div className="bg-muted rounded-lg px-4 py-2">
                <p className="text-lg font-bold">{temperatureStats.mean.toFixed(1)}°C</p>
                <p className="text-xs text-muted-foreground">Promedio</p>
              </div>
              <div className="bg-muted rounded-lg px-4 py-2">
                <p className="text-lg font-bold">{temperatureStats.max.toFixed(1)}°C</p>
                <p className="text-xs text-muted-foreground">Máxima</p>
              </div>
              <div className="bg-muted rounded-lg px-4 py-2">
                <p className="text-lg font-bold">{temperature.length}</p>
                <p className="text-xs text-muted-foreground">
                  {temperature.length === 1 ? "despliegue" : "despliegues"}
                </p>
              </div>
            </div>
          )}

          {/* Overlay chart */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Temperatura por despliegue (°C)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={400}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={formatTickLabel}
                    tick={{ fontSize: 10 }}
                    interval={tickInterval}
                    angle={-30}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    domain={["auto", "auto"]}
                    label={{
                      value: "°C",
                      angle: -90,
                      position: "insideLeft",
                      style: { fontSize: 12 },
                    }}
                  />
                  <Tooltip
                    wrapperStyle={{ zIndex: 10 }}
                    labelFormatter={(label) => formatTickLabel(String(label))}
                    formatter={(value, name) => [
                      `${Number(value).toFixed(1)}°C`,
                      String(name),
                    ]}
                  />
                  <Legend />
                  {deploymentKeys.map((key, i) => (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stroke={DEPLOYMENT_COLORS[i % DEPLOYMENT_COLORS.length]}
                      dot={false}
                      strokeWidth={1.5}
                      connectNulls={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Links to individual deployment pages */}
          <div className="flex flex-wrap gap-2">
            {temperature.map((dep) => (
              <Link
                key={dep.deploymentId}
                href={`/biochoco/ibutton/${dep.deploymentId}`}
                className="text-xs text-blue-600 hover:underline flex items-center gap-1"
              >
                <ExternalLink className="h-3 w-3" />
                {dep.deploymentName}
                {dep.dateRangeStart && (
                  <span className="text-muted-foreground ml-1">
                    ({dep.dateRangeStart.slice(0, 10)})
                  </span>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
