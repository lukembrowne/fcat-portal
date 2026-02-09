"use client";

import { useState, useMemo } from "react";
import { Separator } from "@/components/ui/separator";
import type { TreeRecord, TreeDashboardMetrics, TreeFilterState } from "@/lib/odk-types";
import { MetricsRow } from "./metrics-row";
import { FilterSidebar } from "./filter-sidebar";
import { TreeMap } from "./tree-map";
import { TreeCharts } from "./tree-charts";
import { TreeTable } from "./tree-table";
import { PhotoViewer } from "./photo-viewer";

interface DashboardShellProps {
  trees: TreeRecord[];
}

const emptyFilters: TreeFilterState = {
  farm: "",
  species: "",
  extensionista: "",
  survival: "",
  dateFrom: "",
  dateTo: "",
};

export function DashboardShell({ trees }: DashboardShellProps) {
  const [filters, setFilters] = useState<TreeFilterState>(emptyFilters);
  const [selectedTree, setSelectedTree] = useState<TreeRecord | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);

  const filteredTrees = useMemo(() => {
    return trees.filter((t) => {
      if (filters.farm && t.farm !== filters.farm) return false;
      if (filters.species && t.species !== filters.species) return false;
      if (filters.extensionista && t.worker !== filters.extensionista) return false;
      if (filters.survival && t.survival !== filters.survival) return false;
      if (filters.dateFrom && t.date && t.date < filters.dateFrom) return false;
      if (filters.dateTo && t.date && t.date > filters.dateTo) return false;
      return true;
    });
  }, [trees, filters]);

  const filteredMetrics = useMemo<TreeDashboardMetrics>(() => {
    const uniqueSpecies = new Set(filteredTrees.map((t) => t.species).filter(Boolean));
    const uniqueFarms = new Set(filteredTrees.map((t) => t.farm).filter(Boolean));
    const aliveCount = filteredTrees.filter((t) => t.survival === "vivo").length;
    const survivalRate =
      filteredTrees.length > 0 ? (aliveCount / filteredTrees.length) * 100 : 0;

    return {
      totalTrees: filteredTrees.length,
      uniqueSpecies: uniqueSpecies.size,
      uniqueFarms: uniqueFarms.size,
      survivalRate: Math.round(survivalRate * 10) / 10,
    };
  }, [filteredTrees]);

  function handleViewPhotos(tree: TreeRecord) {
    setSelectedTree(tree);
    setPhotoOpen(true);
  }

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Siembra de Árboles</h1>
        <p className="text-sm text-muted-foreground">
          Datos de siembra de árboles desde ODK Central
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-6">
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <FilterSidebar
            trees={trees}
            filters={filters}
            onFilterChange={setFilters}
            filteredCount={filteredTrees.length}
          />
        </aside>

        <main className="space-y-6 min-w-0">
          <MetricsRow metrics={filteredMetrics} />

          <section>
            <h2 className="text-lg font-semibold mb-3">Ubicaciones de Árboles</h2>
            <TreeMap trees={filteredTrees} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-3">Distribución</h2>
            <TreeCharts trees={filteredTrees} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-3">Todos los Registros</h2>
            <TreeTable trees={filteredTrees} onViewPhotos={handleViewPhotos} />
          </section>
        </main>
      </div>

      <PhotoViewer
        tree={selectedTree}
        open={photoOpen}
        onOpenChange={setPhotoOpen}
      />
    </div>
  );
}
