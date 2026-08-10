import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReadinessTable, type StatusMap } from "./readiness-table";
import { NameLangProvider } from "./name-lang";
import { RunControl } from "./run-control";
import { ReadinessSnapshotControl } from "./readiness-snapshot-control";
import {
  getOccupancyReadinessSnapshot,
  getLatestOccupancyRun,
  listSpeciesModelStatus,
} from "./actions";
import type { ReadinessReport, OccupancyStream } from "@/lib/occupancy/readiness";
import type { DateWindowAnomaly } from "@/lib/occupancy/fetch";
import {
  formatCadenceLabel,
  type AudioSubsampleReport,
} from "@/lib/occupancy/audio-subsample-report";

export const metadata = {
  title: "Modelos de ocupación",
};

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border p-2">
      <div className="text-lg font-semibold tabular-nums leading-tight">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      {hint ? <div className="text-[11px] text-muted-foreground/80">{hint}</div> : null}
    </div>
  );
}

function StreamSection({
  title,
  subtitle,
  report,
  dropped,
  dateAnomalies,
  subsample,
  stream,
  modeled,
}: {
  title: string;
  subtitle: string;
  report: ReadinessReport;
  dropped: number;
  dateAnomalies: DateWindowAnomaly[];
  subsample?: AudioSubsampleReport | null;
  stream: OccupancyStream;
  modeled: StatusMap;
}) {
  const degenerate = subsample?.deployments.filter((d) => d.degenerate) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Sitios muestreados" value={report.nSites} />
          <Stat
            label="Sitios con coordenadas"
            value={report.nSitesWithCoords}
            hint="requerido para el mapa"
          />
          <Stat label="Especies detectadas" value={report.nSpecies} />
          <Stat
            label="Especies listas para modelar"
            value={report.nEligibleSpecies}
          />
        </div>
        {dropped > 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {dropped} instalación(es) con datos quedaron fuera por falta de una ventana de
            muestreo válida (sin fechas de instalación/retiro ni fechas legibles en los archivos).
          </p>
        ) : null}
        {report.detectionsDroppedNoDate > 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {report.detectionsDroppedNoDate} detección(es) sin fecha de captura resoluble
            (nombre de archivo sin fecha, sin EXIF ni fecha de archivo) quedaron fuera del análisis.
          </p>
        ) : null}
        {dateAnomalies.length > 0 ? (
          <div className="rounded-md border border-amber-500/60 bg-amber-50/50 dark:bg-amber-950/20 p-3 space-y-1">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
              {dateAnomalies.length} instalación(es) con archivos fuera de la ventana de
              instalación/retiro (ODK). La ventana ODK es la autoritativa; los archivos con
              fechas fuera de ella se recortan del análisis. Revise si la fecha de ODK o la
              marca de tiempo de los archivos es incorrecta.
            </p>
            <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc pl-5 space-y-0.5">
              {dateAnomalies.map((a) => (
                <li key={a.siteId}>
                  <Link href={`/camera-trap/${a.siteId}`} className="hover:underline font-medium">
                    {a.siteName}
                  </Link>
                  : archivos {a.fileMin} – {a.fileMax} vs ODK {a.odkStart} – {a.odkEnd}
                  {a.noOverlap ? (
                    <span className="font-semibold"> (sin traslape — probable fecha ODK errónea)</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {subsample && subsample.filesTotal > 0 ? (
          <div className="space-y-2">
            {subsample.filesDropped > 0 ? (
              <p className="text-xs text-muted-foreground">
                <strong>Submuestreo de grabaciones:</strong> {subsample.filesDropped.toLocaleString("es")} de{" "}
                {subsample.filesTotal.toLocaleString("es")} grabaciones omitidas para igualar el
                esfuerzo de muestreo a una cadencia de {subsample.bucketMinutes} min (una grabación por
                intervalo). Las instalaciones a 5 min se reducen a la mitad; las de 10 min quedan
                prácticamente iguales.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Submuestreo de grabaciones: sin submuestreo (ninguna instalación tenía cadencia más densa
                que {subsample.bucketMinutes} min).
              </p>
            )}
            {degenerate.length > 0 ? (
              <div className="rounded-md border border-amber-500/60 bg-amber-50/50 dark:bg-amber-950/20 p-3 space-y-1">
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                  {degenerate.length} instalación(es) con cadencia densa pero sin submuestreo aplicado
                  (nombres de archivo no legibles o cadencia no reconocida). Su esfuerzo de muestreo NO
                  es comparable con el resto — revise los nombres de archivo.
                </p>
                <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc pl-5 space-y-0.5">
                  {degenerate.map((d) => (
                    <li key={d.deploymentId}>
                      <Link href={`/audio/${d.deploymentId}`} className="hover:underline font-medium">
                        {d.siteName}
                      </Link>
                      : {formatCadenceLabel(d.nativeCadenceSeconds)}, {d.filesDropped} omitidas
                      {d.filesUnparsed > 0 ? `, ${d.filesUnparsed} sin fecha legible` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">
                Detalle por instalación ({subsample.deployments.length})
              </summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="pr-3 font-medium">Instalación</th>
                      <th className="pr-3 font-medium">Cadencia</th>
                      <th className="pr-3 font-medium text-right">Total</th>
                      <th className="pr-3 font-medium text-right">Conservadas</th>
                      <th className="pr-3 font-medium text-right">Omitidas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subsample.deployments.map((d) => (
                      <tr key={d.deploymentId} className={d.degenerate ? "text-amber-700 dark:text-amber-400" : ""}>
                        <td className="pr-3">
                          <Link href={`/audio/${d.deploymentId}`} className="hover:underline">
                            {d.siteName}
                          </Link>
                        </td>
                        <td className="pr-3">{formatCadenceLabel(d.nativeCadenceSeconds)}</td>
                        <td className="pr-3 text-right tabular-nums">{d.filesTotal.toLocaleString("es")}</td>
                        <td className="pr-3 text-right tabular-nums">{d.filesKept.toLocaleString("es")}</td>
                        <td className="pr-3 text-right tabular-nums">{d.filesDropped.toLocaleString("es")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        ) : null}
        <ReadinessTable rows={report.species} stream={stream} modeled={modeled} />
      </CardContent>
    </Card>
  );
}

export default async function OccupancyPage() {
  const user = await requirePermission("camera-trap", "viewer");
  const isAdmin =
    user.globalRole === "super_admin" ||
    user.permissions.some((p) => p.projectId === "camera-trap" && p.role === "admin");
  // Editors and admins may refresh the readiness snapshot (the heavy recompute
  // moved off page load); viewers see the timestamp + stale hint only.
  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "camera-trap" && (p.role === "admin" || p.role === "editor"),
    );
  const [result, runInfo, modeled] = await Promise.all([
    getOccupancyReadinessSnapshot(),
    getLatestOccupancyRun(),
    listSpeciesModelStatus(),
  ]);
  const modeledSpecies = modeled.success ? modeled.data : [];
  // Per-stream lookup of each species' model outcome (modeled ψ/p, casi ubicua, or
  // no estimable) so the readiness table can show an honest state instead of a
  // bare "—" for species whose fit hit the ψ ceiling.
  const modeledByStream = (stream: OccupancyStream): StatusMap =>
    new Map(
      modeledSpecies.filter((m) => m.stream === stream).map((m) => [m.species, m]),
    );

  if (!result.success) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Modelos de ocupación</h1>
        <p className="text-sm text-red-600">{result.error}</p>
      </div>
    );
  }

  const { snapshot, stale, generatedAt } = result.data;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Modelos de ocupación</h1>
        <p className="text-muted-foreground max-w-3xl">
          Los modelos de ocupación estiman <em>dónde es probable que ocurra</em> una especie —
          no solo dónde fue detectada — corrigiendo por la detección imperfecta. Para cada
          especie ajustaremos un modelo de una temporada (paquete <code>unmarked</code> en R) y
          mostraremos su ocurrencia predicha en el área de estudio.
        </p>
      </header>

      <div className="rounded-lg border px-4 py-2">
        <RunControl
          isAdmin={isAdmin}
          info={
            runInfo.success
              ? runInfo.data
              : { run: null, activeJob: null, thresholdChanges: [] }
          }
        />
      </div>

      <div className="rounded-lg border px-4 py-2">
        <ReadinessSnapshotControl isEditor={isEditor} stale={stale} generatedAt={generatedAt} />
      </div>

      <NameLangProvider>
      {modeledSpecies.length > 0 ? (
        <Link
          href="/ocupacion/cross-species"
          className="block rounded-lg border-2 border-emerald-500/60 bg-emerald-50/60 dark:bg-emerald-950/30 p-4 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-base font-semibold text-emerald-800 dark:text-emerald-300">
                Síntesis entre especies
              </div>
              <p className="text-sm text-muted-foreground">
                Riqueza predicha, ocupación general y por hábitat, y respuestas ambientales de
                las {modeledSpecies.length} especies modeladas. Abre una especie desde las tablas
                de abajo para ver su mapa de ocurrencia predicha, uso de hábitat y diagnósticos.
              </p>
            </div>
            <span className="shrink-0 text-emerald-700 dark:text-emerald-400 font-medium">
              Ver síntesis →
            </span>
          </div>
        </Link>
      ) : null}

      {snapshot ? (
        <>
          <StreamSection
            title="Cámaras trampa"
            subtitle="Solo instalaciones verificadas (imágenes confirmadas) y no excluidas; solo detecciones verificadas o corregidas."
            report={snapshot.camera}
            dropped={snapshot.cameraSitesDropped}
            dateAnomalies={snapshot.cameraDateAnomalies}
            stream="camera"
            modeled={modeledByStream("camera")}
          />

          <StreamSection
            title="Grabaciones de audio"
            subtitle={`Mismas instalaciones verificadas y no excluidas que cámaras trampa. Detecciones con confianza ≥ ${(snapshot.audio.confidenceThreshold ?? 0.7).toFixed(2)} (o verificadas). La confianza de BirdNET no es una probabilidad y varía entre especies — umbral global como primer criterio.`}
            report={snapshot.audio}
            dropped={snapshot.audioSitesDropped}
            dateAnomalies={snapshot.audioDateAnomalies}
            subsample={snapshot.audioSubsample}
            stream="audio"
            modeled={modeledByStream("audio")}
          />
        </>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground space-y-1">
            <p>Aún no se ha calculado la disponibilidad de datos.</p>
            {isEditor ? (
              <p>Presione «Actualizar disponibilidad» para calcularla.</p>
            ) : null}
          </CardContent>
        </Card>
      )}
      </NameLangProvider>

      {snapshot ? (
        <footer className="text-xs text-muted-foreground border-t pt-4 space-y-1">
          <p>
            <strong>Métodos:</strong> ocasiones de {snapshot.camera.binWidth} días; sitio = instalación;
            ventana de muestreo por fechas de instalación/retiro (ODK) unida a las fechas de captura
            (nombre de archivo, EXIF o fecha de archivo). Las <em>ocasiones</em> son el ancho de la
            matriz de muestreo (máximo entre sitios), por eso son iguales para todas las especies.
            Umbrales de elegibilidad: ≥{snapshot.camera.thresholds.minSites} sitios,
            ≥{snapshot.camera.thresholds.minSitesDetected} sitios con detección,
            ≥{snapshot.camera.thresholds.minDetections} detecciones,
            ≥{snapshot.camera.thresholds.minOccasions} ocasiones.
          </p>
          <p>Generado: {generatedAt ? new Date(generatedAt).toLocaleString("es-EC") : "—"}</p>
        </footer>
      ) : null}
    </div>
  );
}
