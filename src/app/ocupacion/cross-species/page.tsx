import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCrossSpeciesData } from "../actions";
import { ForestPlotChart, HabitatUseChart } from "../charts";

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
        nearUbiquitous: [],
        nSpeciesModeled: 0,
      };

  const nExcluded = data.nearUbiquitous.length;
  // Footnote appended under each model plot so the reader sees these species were
  // excluded, not that they don't exist.
  const excludedNote =
    nExcluded > 0 ? (
      <p className="text-xs text-muted-foreground mt-2">
        +{nExcluded} especie{nExcluded === 1 ? "" : "s"} casi ubicua{nExcluded === 1 ? "" : "s"}{" "}
        excluida{nExcluded === 1 ? "" : "s"} (ψ no estimable — ver abajo).
      </p>
    ) : null;

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
                {excludedNote}
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
                {excludedNote}
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
              {excludedNote}
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
                {excludedNote}
              </CardContent>
            </Card>
          ) : null}

          {data.nearUbiquitous.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Especies casi ubicuas (ψ no estimable)</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Ocupan casi todos los sitios; la ocupación (ψ) queda en el límite (≈100%) y no es
                  estimable como punto con IC, por lo que se excluyen de los gráficos de modelo de
                  arriba. Se listan aquí para que la síntesis no quede sesgada contra las especies
                  más comunes.
                </p>
              </CardHeader>
              <CardContent>
                <ul className="text-sm space-y-1">
                  {data.nearUbiquitous.map((s) => (
                    <li key={`${s.species}|${s.stream}`} className="flex justify-between gap-4">
                      <span className="italic">{s.species}</span>
                      <span className="text-muted-foreground tabular-nums whitespace-nowrap">
                        detectada en {s.nSitesDetected}/{s.nSites} sitios (
                        {Math.round(s.naiveOccupancy * 100)}%)
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
