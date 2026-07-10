import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCrossSpeciesData } from "../actions";
import { ForestPlotChart, HabitatUseChart } from "../charts";
import { OccupancyMapClient } from "../occupancy-map-client";

export const dynamic = "force-dynamic";

export default async function CrossSpeciesPage() {
  await requirePermission("camera-trap", "viewer");
  const result = await getCrossSpeciesData();
  const data = result.success
    ? result.data
    : {
        forestPlot: [],
        elevationPlot: [],
        forestMean: null,
        elevationMean: null,
        overallPlot: [],
        habitatOccupancy: [],
        richness: null,
        maxRichness: 0,
        nSpeciesModeled: 0,
      };

  return (
    <div className="p-6 max-w-screen-2xl mx-auto space-y-6">
      <div className="text-sm">
        <Link href="/ocupacion" className="text-muted-foreground hover:underline">
          ← Ocupación
        </Link>
      </div>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Síntesis entre especies</h1>
        <p className="text-sm text-muted-foreground">
          {data.nSpeciesModeled} especies modeladas en la última corrida.
        </p>
      </header>

      {data.nSpeciesModeled === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Aún no hay modelos ajustados. Corre el batch de ocupación para ver la síntesis.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Riqueza predicha</CardTitle>
              <p className="text-xs text-muted-foreground">
                Suma de la ocupación predicha (Σψ) entre especies — número esperado de especies por
                celda. Proyección de hábitat, no espacialmente explícita.
              </p>
            </CardHeader>
            <CardContent>
              {data.richness ? (
                <OccupancyMapClient
                  runId={data.richness.runId}
                  psiName={data.richness.psiName}
                  hasForest={false}
                  hasElevation={false}
                  bbox={data.richness.bbox}
                  cells={data.richness.cells}
                  legend={{ kind: "richness", max: data.maxRichness }}
                />
              ) : (
                <div className="rounded-lg border p-6 text-sm text-muted-foreground">
                  Superficie de riqueza no disponible.
                </div>
              )}
              {data.maxRichness > 0 ? (
                <p className="text-xs text-muted-foreground mt-2">
                  Riqueza máxima estimada: {data.maxRichness.toFixed(1)} especies.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {data.overallPlot.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ocupación general por especie</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Ocupación estimada (ψ) de cada especie con IC 95%. Haz clic en el nombre para
                  abrir su página.
                </p>
              </CardHeader>
              <CardContent>
                <ForestPlotChart rows={data.overallPlot} unitLabel="ocupación" mode="probability" />
              </CardContent>
            </Card>
          ) : null}

          {data.habitatOccupancy.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ocupación por hábitat (entre especies)</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Ocupación media (ψ) por tipo de hábitat, resumida entre las especies modeladas,
                  con IC 95% de la media entre especies.
                </p>
              </CardHeader>
              <CardContent>
                <HabitatUseChart
                  bars={data.habitatOccupancy.map((h) => ({
                    habitat: `${h.habitat} (n=${h.nSpecies})`,
                    psi: h.meanPsi,
                    lower: h.lower,
                    upper: h.upper,
                    isReference: false,
                  }))}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Respuesta a la cobertura boscosa</CardTitle>
              <p className="text-xs text-muted-foreground">
                Efecto (pendiente de ocupación) de la cobertura boscosa por especie, con IC 95%.
                {data.forestMean != null
                  ? ` Promedio ponderado: ${data.forestMean.toFixed(2)}.`
                  : ""}
              </p>
            </CardHeader>
            <CardContent>
              <ForestPlotChart rows={data.forestPlot} unitLabel="cobertura boscosa" />
            </CardContent>
          </Card>

          {data.elevationPlot.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Respuesta a la elevación</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Efecto de la elevación por especie, con IC 95%.
                  {data.elevationMean != null
                    ? ` Promedio ponderado: ${data.elevationMean.toFixed(2)}.`
                    : ""}
                </p>
              </CardHeader>
              <CardContent>
                <ForestPlotChart rows={data.elevationPlot} unitLabel="elevación" />
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
