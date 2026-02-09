"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import type { ScheduleRow } from "@/lib/schedule-types";
import { getHabitatName, getDeploymentStatus } from "./types";

interface HabitatChartProps {
  schedule: ScheduleRow[];
  deployedSet: Set<string>;
  retrievedSet: Set<string>;
}

export function HabitatChart({ schedule, deployedSet, retrievedSet }: HabitatChartProps) {
  const data = useMemo(() => {
    const groups: Record<string, { programado: number; instalado: number; recuperado: number }> = {};

    for (const row of schedule) {
      const habitat = getHabitatName(row.habitatType);
      if (!groups[habitat]) groups[habitat] = { programado: 0, instalado: 0, recuperado: 0 };

      const status = getDeploymentStatus(row.deploymentId, deployedSet, retrievedSet);
      if (status === "retrieved") groups[habitat].recuperado++;
      else if (status === "deployed") groups[habitat].instalado++;
      else groups[habitat].programado++;
    }

    return Object.entries(groups)
      .map(([habitat, counts]) => ({ habitat, ...counts }))
      .sort((a, b) => {
        const totalA = a.programado + a.instalado + a.recuperado;
        const totalB = b.programado + b.instalado + b.recuperado;
        return totalB - totalA;
      });
  }, [schedule, deployedSet, retrievedSet]);

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin datos</p>;
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <ResponsiveContainer width="100%" height={350}>
          <BarChart data={data}>
            <XAxis dataKey="habitat" tick={{ fontSize: 11 }} />
            <YAxis />
            <Tooltip />
            <Legend />
            <Bar dataKey="programado" name="Programado" stackId="a" fill="#6c757d" />
            <Bar dataKey="instalado" name="Instalado" stackId="a" fill="#28a745" />
            <Bar dataKey="recuperado" name="Recuperado" stackId="a" fill="#fd7e14" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
