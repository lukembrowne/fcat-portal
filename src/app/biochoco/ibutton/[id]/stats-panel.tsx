"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Thermometer, TrendingDown, TrendingUp, Hash, BarChart3, Flag, Cpu, Clock, FileText, User } from "lucide-react";
import type { DeploymentDetail } from "../types";

export function StatsPanel({
  stats,
  upload,
}: {
  stats: DeploymentDetail["stats"];
  upload: DeploymentDetail["upload"];
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Stats */}
      {stats && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Estadísticas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <StatItem
                icon={TrendingDown}
                label="Mínima"
                value={`${stats.min}°C`}
                color="text-blue-600"
              />
              <StatItem
                icon={Thermometer}
                label="Promedio"
                value={`${stats.mean}°C`}
                color="text-orange-600"
              />
              <StatItem
                icon={TrendingUp}
                label="Máxima"
                value={`${stats.max}°C`}
                color="text-red-600"
              />
              <StatItem
                icon={BarChart3}
                label="Desv. Estándar"
                value={`${stats.stdDev}°C`}
                color="text-violet-600"
              />
              <StatItem
                icon={Hash}
                label="Lecturas"
                value={stats.count.toLocaleString("es")}
                color="text-emerald-600"
              />
              <StatItem
                icon={Flag}
                label="Marcadas"
                value={String(stats.flaggedCount)}
                color="text-amber-600"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Device & Upload Info */}
      {upload && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Información del dispositivo</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              {upload.deviceSerial && (
                <InfoRow icon={Cpu} label="Serial" value={upload.deviceSerial} />
              )}
              {upload.sampleRate && (
                <InfoRow
                  icon={Clock}
                  label="Tasa de muestreo"
                  value={upload.sampleRate}
                />
              )}
              {upload.missionStart && (
                <InfoRow
                  icon={Clock}
                  label="Inicio de misión"
                  value={upload.missionStart}
                />
              )}
              <InfoRow
                icon={FileText}
                label="Archivo"
                value={upload.filename}
              />
              {upload.dateRangeStart && upload.dateRangeEnd && (
                <InfoRow
                  icon={Clock}
                  label="Rango de datos"
                  value={`${upload.dateRangeStart.slice(0, 10)} — ${upload.dateRangeEnd.slice(0, 10)}`}
                />
              )}
              <InfoRow
                icon={User}
                label="Procesado por"
                value={`${upload.processedBy} (${new Date(upload.processedAt).toLocaleDateString("es")})`}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatItem({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: typeof Thermometer;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className={`h-4 w-4 ${color}`} />
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-semibold">{value}</p>
      </div>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5" />
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-medium break-all">{value}</p>
      </div>
    </div>
  );
}
