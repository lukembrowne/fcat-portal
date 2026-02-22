"use client";

import { useState, useMemo } from "react";
import { Separator } from "@/components/ui/separator";
import type {
  SocialActivityRecord,
  SocialActivityMetrics,
  SocialActivityFilterState,
} from "@/lib/odk-types";
import { MetricsRow } from "./metrics-row";
import { FilterBar } from "./filter-bar";
import { ActivityCharts } from "./activity-charts";
import { ActivityTable } from "./activity-table";
import { PhotoViewer } from "./photo-viewer";

interface DashboardShellProps {
  activities: SocialActivityRecord[];
}

const emptyFilters: SocialActivityFilterState = {
  dateFrom: "",
  dateTo: "",
  tipoEvento: [],
  areaDesarrollo: [],
  proyectoFcat: [],
  lugarEvento: [],
};

export function DashboardShell({ activities }: DashboardShellProps) {
  const [filters, setFilters] =
    useState<SocialActivityFilterState>(emptyFilters);
  const [selectedActivity, setSelectedActivity] =
    useState<SocialActivityRecord | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);

  const filteredActivities = useMemo(() => {
    return activities.filter((a) => {
      if (filters.dateFrom && a.fecha && a.fecha < filters.dateFrom)
        return false;
      if (filters.dateTo && a.fecha && a.fecha > filters.dateTo) return false;
      if (
        filters.tipoEvento.length > 0 &&
        !filters.tipoEvento.includes(a.tipoEvento)
      )
        return false;
      if (
        filters.areaDesarrollo.length > 0 &&
        !a.areasDesarrollo.some((ad) => filters.areaDesarrollo.includes(ad))
      )
        return false;
      if (
        filters.proyectoFcat.length > 0 &&
        !a.proyectosFcat.some((p) => filters.proyectoFcat.includes(p))
      )
        return false;
      if (
        filters.lugarEvento.length > 0 &&
        !filters.lugarEvento.includes(a.lugarEvento)
      )
        return false;
      return true;
    });
  }, [activities, filters]);

  const filteredMetrics = useMemo<SocialActivityMetrics>(() => {
    const totalParticipantes = filteredActivities.reduce(
      (sum, a) => sum + a.totalParticipantes,
      0
    );
    const totalMujeres = filteredActivities.reduce(
      (sum, a) => sum + a.numMujeres,
      0
    );
    const uniqueCommunities = new Set(
      filteredActivities
        .map((a) => a.comunidadesInstituciones.toLowerCase().trim())
        .filter(Boolean)
    );

    return {
      totalEventos: filteredActivities.length,
      totalParticipantes,
      totalMujeres,
      porcentajeMujeres:
        totalParticipantes > 0
          ? Math.round((totalMujeres / totalParticipantes) * 100)
          : 0,
      comunidadesAlcanzadas: uniqueCommunities.size,
      promedioParticipantes:
        filteredActivities.length > 0
          ? Math.round(totalParticipantes / filteredActivities.length)
          : 0,
    };
  }, [filteredActivities]);

  function handleViewPhotos(activity: SocialActivityRecord) {
    setSelectedActivity(activity);
    setPhotoOpen(true);
  }

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Actividades Sociales</h1>
        <p className="text-sm text-muted-foreground">
          Registro de talleres, reuniones y capacitaciones desde ODK Central
        </p>
      </div>

      <FilterBar
        activities={activities}
        filters={filters}
        onFilterChange={setFilters}
        filteredCount={filteredActivities.length}
      />

      <div className="mt-6 space-y-6">
        <MetricsRow metrics={filteredMetrics} />

        <Separator />

        <section>
          <h2 className="text-lg font-semibold mb-3">Visualización</h2>
          <ActivityCharts activities={filteredActivities} />
        </section>

        <Separator />

        <section>
          <h2 className="text-lg font-semibold mb-3">
            Todas las Actividades
          </h2>
          <ActivityTable
            activities={filteredActivities}
            onViewPhotos={handleViewPhotos}
          />
        </section>
      </div>

      <PhotoViewer
        activity={selectedActivity}
        open={photoOpen}
        onOpenChange={setPhotoOpen}
      />
    </div>
  );
}
