import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { fetchResultadosData } from "./actions";
import { SitioView } from "./sitio-view";
import { HabitatView } from "./habitat-view";
import { DashboardTabs, type DashboardView } from "./dashboard-tabs";

interface PageProps {
  searchParams: Promise<{ view?: string }>;
}

export default async function ResultadosPage({ searchParams }: PageProps) {
  await requirePermission("biochoco", "viewer");
  const { view } = await searchParams;
  const active: DashboardView = view === "habitat" ? "habitat" : "sitio";

  return (
    <div className="space-y-6 min-w-0">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Resultados</h1>
        <p className="text-muted-foreground">
          Monitoreo integrado: cámaras trampa, audio y temperatura.
        </p>
      </div>

      <DashboardTabs active={active} />

      {active === "habitat" ? (
        <Suspense fallback={<HabitatLoading />}>
          <HabitatView />
        </Suspense>
      ) : (
        <SitioViewLoader />
      )}
    </div>
  );
}

async function SitioViewLoader() {
  const result = await fetchResultadosData();
  if (!result.success) {
    return (
      <div className="flex h-[400px] items-center justify-center">
        <p className="text-destructive">{result.error}</p>
      </div>
    );
  }
  return <SitioView data={result.data} />;
}

function HabitatLoading() {
  return (
    <div className="space-y-4">
      <div className="h-20 animate-pulse rounded-md border bg-muted/30" />
      <div className="h-80 animate-pulse rounded-md border bg-muted/30" />
      <div className="h-60 animate-pulse rounded-md border bg-muted/30" />
    </div>
  );
}
