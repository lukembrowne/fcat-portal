import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSpeciesModel, getModelInputSample } from "../actions";
import { HabitatUseChart, ResponseCurveChart } from "../charts";
import { OccupancyMapClient } from "../occupancy-map-client";
import { DetectionSampleTable } from "../detection-sample-table";
import { isSeparated } from "@/lib/occupancy/separation";

export const dynamic = "force-dynamic";

const STREAM_LABEL: Record<string, string> = { camera: "Cámaras trampa", audio: "Audio" };
const Z95 = 1.959964;

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

/** Batch completion timestamp → readable Ecuador-local date + time. */
function formatFittedAt(iso: string): string {
  try {
    return new Intl.DateTimeFormat("es-EC", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Guayaquil",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export default async function SpeciesOccupancyPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ stream?: string }>;
}) {
  await requirePermission("camera-trap", "viewer");
  const { slug } = await params;
  const { stream: streamParam } = await searchParams;
  const species = decodeURIComponent(slug);
  const stream = streamParam === "audio" ? "audio" : "camera";

  const [result, sampleResult] = await Promise.all([
    getSpeciesModel(species, stream),
    getModelInputSample(species, stream),
  ]);
  const model = result.success ? result.data : null;
  const inputSample = sampleResult.success ? sampleResult.data : null;

  // Habitat levels whose coefficient blew up (complete separation) are not
  // estimable — flag them so the bar chart shows "no estimable" instead of a
  // spurious 0–100% whisker. The reference level has no coefficient (always ok).
  const separatedHabitats = new Set(
    (model?.effects ?? [])
      .filter((e) => e.submodel === "state" && e.param.startsWith("habitat") && isSeparated(e.estimate, e.se))
      .map((e) => e.param.slice("habitat".length)),
  );
  const habitatBars = (model?.habitatUse ?? []).map((b) => ({
    ...b,
    estimable: !separatedHabitats.has(b.habitat),
  }));

  // Radius of the buffer the forest-cover covariate is computed over (and the
  // scale the ψ surface is predicted at) — surfaced so the covariate is
  // unambiguous. Matches OCCUPANCY_BUFFER_METERS used at fit time.
  const forestBufferM = Number(process.env.OCCUPANCY_BUFFER_METERS ?? 500);

  return (
    <div className="p-6 max-w-screen-2xl mx-auto space-y-6">
      <div className="text-sm">
        <Link href="/ocupacion" className="text-muted-foreground hover:underline">
          ← Ocupación
        </Link>
      </div>

      <header className="space-y-1">
        <h1 className="text-2xl font-bold italic">{species}</h1>
        <p className="text-sm text-muted-foreground">
          {STREAM_LABEL[stream]}
          {model?.fittedAt ? (
            <> · Modelo ajustado el {formatFittedAt(model.fittedAt)}</>
          ) : null}
        </p>
      </header>

      {!model ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No hay un modelo ajustado para esta especie en {STREAM_LABEL[stream].toLowerCase()}.
            Puede que los datos aún sean insuficientes o que no se haya corrido el batch.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Headline */}
          <Card>
            <CardContent className="pt-6">
              <p className="text-lg">
                Ocupación estimada:{" "}
                <strong>
                  {model.estimatedOccupancy != null ? pct(model.estimatedOccupancy) : "—"}
                </strong>{" "}
                {model.occupancyLower != null && model.occupancyUpper != null ? (
                  <span className="text-muted-foreground">
                    (IC 95%: {pct(model.occupancyLower)}–{pct(model.occupancyUpper)}){" "}
                  </span>
                ) : null}
                del área muestreada
                {model.naiveOccupancy != null ? (
                  <span className="text-muted-foreground"> (ingenua: {pct(model.naiveOccupancy)})</span>
                ) : null}
                .
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                La ocupación estimada corrige por la detección imperfecta (p ={" "}
                {model.meanDetection != null ? model.meanDetection.toFixed(2) : "—"}).
              </p>
            </CardContent>
          </Card>

          {/* Covariates omitted from this model — makes a reduced ψ~1 fit visible */}
          {model.droppedCovariates.length > 0 ? (
            <Card className="border-amber-500/60 bg-amber-50/50 dark:bg-amber-950/20">
              <CardHeader>
                <CardTitle className="text-base text-amber-800 dark:text-amber-300">
                  Covariables omitidas
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Estas covariables no entraron al modelo, por lo que el ajuste es reducido (no
                  refleja su efecto). Corrija los datos o las capas indicadas y vuelva a correr el
                  batch.
                </p>
              </CardHeader>
              <CardContent>
                <ul className="text-sm list-disc pl-5 space-y-1">
                  {model.droppedCovariates.map((d, i) => (
                    <li key={i}>
                      <span className="font-medium">{d.name}</span>: {d.reason}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {/* Predicted-occurrence raster */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ocurrencia predicha</CardTitle>
              <p className="text-xs text-muted-foreground">
                Superficie de ψ sobre los gradientes de cobertura boscosa (buffer de {forestBufferM} m)
                y elevación (hábitat fijado en su nivel más común). Active las capas para ver las
                covariables, la reserva y los sitios de muestreo.
              </p>
            </CardHeader>
            <CardContent>
              {model.prediction ? (
                <OccupancyMapClient
                  runId={model.prediction.runId}
                  psiName={model.prediction.psiName}
                  hasForest={model.prediction.hasForest}
                  hasElevation={model.prediction.hasElevation}
                  bbox={model.prediction.bbox}
                  cells={model.prediction.cells}
                  sites={model.prediction.sites}
                />
              ) : (
                <div className="rounded-lg border p-6 text-sm text-muted-foreground">
                  Superficie de ocurrencia predicha no disponible (requiere las capas ráster de
                  cobertura boscosa y elevación del área de estudio).
                </div>
              )}
            </CardContent>
          </Card>

          {/* Habitat use */}
          {model.habitatUse.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Uso de hábitat</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Ocupación predicha por tipo de hábitat con IC 95% (barra tenue = nivel de
                  referencia).
                </p>
              </CardHeader>
              <CardContent>
                <HabitatUseChart bars={habitatBars} />
              </CardContent>
            </Card>
          ) : null}

          {/* Response curves */}
          {(model.forestCurve.length > 0 || model.elevationCurve.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Relación con el ambiente</CardTitle>
                <p className="text-xs text-muted-foreground">
                  ψ predicha (línea) con banda de IC 95%.
                </p>
              </CardHeader>
              <CardContent className="grid gap-6 sm:grid-cols-2">
                {model.forestCurve.length > 0 ? (
                  <ResponseCurveChart
                    points={model.forestCurve}
                    xLabel="Cobertura boscosa"
                    xUnit="percent"
                  />
                ) : null}
                {model.elevationCurve.length > 0 ? (
                  <ResponseCurveChart
                    points={model.elevationCurve}
                    xLabel="Elevación (m)"
                    xUnit="meters"
                  />
                ) : null}
              </CardContent>
            </Card>
          )}

          {/* Scientist detail */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Para científicos</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1">Submodelo</th>
                      <th>Parámetro</th>
                      <th className="text-right">Estimado</th>
                      <th className="text-right">EE</th>
                      <th className="text-right">IC 95%</th>
                      <th className="text-right">z</th>
                      <th className="text-right">p</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.effects.map((e, i) => {
                      // Complete separation → the coefficient is not identifiable;
                      // show "no estimable" rather than a spurious 0–100% CI.
                      const separated = isSeparated(e.estimate, e.se);
                      const lo = e.se != null ? e.estimate - Z95 * e.se : null;
                      const hi = e.se != null ? e.estimate + Z95 * e.se : null;
                      // Significant when the 95% CI excludes 0 (matches the
                      // cross-species forest-plot convention). Never for separated.
                      const sig = !separated && lo != null && hi != null && (lo > 0 || hi < 0);
                      return (
                        <tr
                          key={i}
                          className={`border-t ${sig ? "font-semibold" : ""} ${separated ? "text-muted-foreground" : ""}`}
                        >
                          <td className="py-1">
                            {e.submodel === "state" ? "ψ (ocupación)" : "p (detección)"}
                          </td>
                          <td>
                            {e.param}
                            {sig ? <span title="IC 95% excluye 0"> *</span> : null}
                          </td>
                          {separated ? (
                            <td className="text-right italic" colSpan={5}>
                              no estimable — datos insuficientes (separación)
                            </td>
                          ) : (
                            <>
                              <td className="text-right tabular-nums">{e.estimate.toFixed(3)}</td>
                              <td className="text-right tabular-nums">{e.se != null ? e.se.toFixed(3) : "—"}</td>
                              <td className="text-right tabular-nums">
                                {lo != null && hi != null ? `${lo.toFixed(2)}, ${hi.toFixed(2)}` : "—"}
                              </td>
                              <td className="text-right tabular-nums">{e.z != null ? e.z.toFixed(2) : "—"}</td>
                              <td className="text-right tabular-nums">{e.pValue != null ? e.pValue.toFixed(3) : "—"}</td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4 text-xs">
                <Diag label="Sitios" value={model.nSites} />
                <Diag label="Sitios con detección" value={model.nSitesDetected} />
                <Diag label="Detecciones" value={model.totalDetections} />
                <Diag label="Ocasiones" value={model.nOccasions} />
                <Diag label="AIC" value={model.aic != null ? model.aic.toFixed(1) : "—"} />
                <Diag label="Convergencia" value={model.convergence === 0 ? "sí" : "revisar"} />
                <Diag label="Ajuste" value={model.fitSeconds != null ? `${model.fitSeconds.toFixed(2)} s` : "—"} />
              </dl>
              <p className="text-xs text-muted-foreground">
                Modelo: ψ {model.psiFormula} · p {model.detFormula}. Cobertura boscosa = proporción
                de bosque en un buffer de {forestBufferM} m alrededor de cada sitio (misma escala
                usada para predecir la superficie de ψ). Covariables continuas estandarizadas; curvas
                retransformadas a la escala original. Fila en negrita (*) = efecto con IC 95% que
                excluye 0.
              </p>
              {inputSample && inputSample.rows.length > 0 ? (
                <div className="border-t pt-4">
                  <div className="text-sm font-medium mb-2">Datos de entrada (sitio × ocasión)</div>
                  <DetectionSampleTable sample={inputSample} />
                </div>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Diag({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
