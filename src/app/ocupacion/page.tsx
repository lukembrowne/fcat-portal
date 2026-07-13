import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReadinessTable, type ModeledMap } from "./readiness-table";
import { RunControl } from "./run-control";
import {
  getOccupancyReadiness,
  getLatestOccupancyRun,
  listModeledSpecies,
} from "./actions";
import type { ReadinessReport, OccupancyStream } from "@/lib/occupancy/readiness";

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
  stream,
  modeled,
}: {
  title: string;
  subtitle: string;
  report: ReadinessReport;
  dropped: number;
  stream: OccupancyStream;
  modeled: ModeledMap;
}) {
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
  const [result, runInfo, modeled] = await Promise.all([
    getOccupancyReadiness(),
    getLatestOccupancyRun(),
    listModeledSpecies(),
  ]);
  const modeledSpecies = modeled.success ? modeled.data : [];
  // Per-stream lookup of the fitted ψ + p so the readiness tables can show the
  // modeled numbers alongside the raw counts (— when a species isn't modeled).
  const modeledByStream = (stream: OccupancyStream): ModeledMap =>
    new Map(
      modeledSpecies
        .filter((m) => m.stream === stream)
        .map((m) => [m.species, { psi: m.estimatedOccupancy, p: m.meanDetection }]),
    );

  if (!result.success) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Modelos de ocupación</h1>
        <p className="text-sm text-red-600">{result.error}</p>
      </div>
    );
  }

  const { camera, audio, cameraSitesDropped, audioSitesDropped, generatedAt } = result.data;
  const t = camera.thresholds;

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
          info={runInfo.success ? runInfo.data : { run: null, activeJob: null }}
        />
      </div>

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

      <StreamSection
        title="Cámaras trampa"
        subtitle="Solo instalaciones verificadas (imágenes confirmadas) y no excluidas; solo detecciones verificadas o corregidas."
        report={camera}
        dropped={cameraSitesDropped}
        stream="camera"
        modeled={modeledByStream("camera")}
      />

      <StreamSection
        title="Grabaciones de audio"
        subtitle={`Mismas instalaciones verificadas y no excluidas que cámaras trampa. Detecciones con confianza ≥ ${(audio.confidenceThreshold ?? 0.7).toFixed(2)} (o verificadas). La confianza de BirdNET no es una probabilidad y varía entre especies — umbral global como primer criterio.`}
        report={audio}
        dropped={audioSitesDropped}
        stream="audio"
        modeled={modeledByStream("audio")}
      />

      <footer className="text-xs text-muted-foreground border-t pt-4 space-y-1">
        <p>
          <strong>Métodos:</strong> ocasiones de {camera.binWidth} días; sitio = instalación;
          ventana de muestreo por fechas de instalación/retiro (ODK) unida a las fechas de captura
          (nombre de archivo, EXIF o fecha de archivo). Las <em>ocasiones</em> son el ancho de la
          matriz de muestreo (máximo entre sitios), por eso son iguales para todas las especies.
          Umbrales de elegibilidad: ≥{t.minSites} sitios, ≥{t.minSitesDetected} sitios con detección,
          ≥{t.minDetections} detecciones, ≥{t.minOccasions} ocasiones.
        </p>
        <p>Generado: {new Date(generatedAt).toLocaleString("es-EC")}</p>
      </footer>
    </div>
  );
}
