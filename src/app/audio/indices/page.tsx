import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import {
  fetchDistinctAudioProjects,
  getAcousticIndicesForProject,
  type AcousticIndicesGroup,
} from "../actions";
import {
  DIEL_PERIODS,
  DIEL_PERIOD_LABELS,
  type DielPeriod,
} from "@/lib/acoustic-indices";
import { AcousticIndicesBoxPlot } from "./acoustic-indices-box-plot";

interface PageSearchParams {
  project?: string;
  period?: string;
}

interface IndexDescriptor {
  key:
    | "soundscapeSaturation"
    | "acousticComplexityIndex"
    | "frequencyEntropy"
    | "temporalEntropy"
    | "eventsPerSecond";
  title: string;
  description: string;
  direction: "up" | "down" | "neutral";
  unit?: string;
}

const INDEX_DESCRIPTORS: IndexDescriptor[] = [
  {
    key: "soundscapeSaturation",
    title: "Saturación del paisaje sonoro",
    description:
      "Proporción del espectro de frecuencias ocupada por sonido sobre el ruido de fondo. Indica qué tan «lleno» está el paisaje sonoro acústicamente (Burivalova et al. 2018).",
    direction: "up",
    unit: "proporción (0–1)",
  },
  {
    key: "acousticComplexityIndex",
    title: "Índice de complejidad acústica (ACI)",
    description:
      "Variabilidad rápida de amplitud dentro de cada banda de frecuencia (Pieretti et al. 2011).",
    direction: "down",
    unit: "ACI",
  },
  {
    key: "frequencyEntropy",
    title: "Entropía de frecuencia",
    description:
      "Qué tan uniformemente se distribuye la energía a lo largo del espectro.",
    direction: "up",
    unit: "Hf (0–1)",
  },
  {
    key: "temporalEntropy",
    title: "Entropía temporal",
    description:
      "Qué tan uniformemente se distribuye la energía en el tiempo.",
    direction: "neutral",
    unit: "Ht (0–1)",
  },
  {
    key: "eventsPerSecond",
    title: "Eventos por segundo",
    description:
      "Conteo de eventos acústicos discretos por unidad de tiempo (Towsey 2018).",
    direction: "down",
    unit: "eventos/s",
  },
];

function normalizePeriod(raw: string | undefined): DielPeriod {
  const candidate = raw as DielPeriod | undefined;
  return candidate && (DIEL_PERIODS as readonly string[]).includes(candidate)
    ? candidate
    : "dawn";
}

function filterByPeriod(
  groups: AcousticIndicesGroup[],
  period: DielPeriod,
): AcousticIndicesGroup[] {
  return groups.filter((g) => g.dielPeriod === period);
}

export default async function AcousticIndicesPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  await requirePermission("grabaciones", "viewer");

  const sp = await searchParams;
  const period = normalizePeriod(sp.period);

  const distinctProjects = await fetchDistinctAudioProjects();
  const projects = [...distinctProjects].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const requestedProjectId = sp.project ? Number(sp.project) : null;
  const selectedProject =
    (requestedProjectId
      ? projects.find((p) => p.id === requestedProjectId)
      : null) ?? projects[0] ?? null;

  const result = selectedProject
    ? await getAcousticIndicesForProject(selectedProject.id)
    : null;
  const data = result?.success ? result.data : { groups: [], totalDeployments: 0 };
  const filtered = filterByPeriod(data.groups, period);

  return (
    <div className="max-w-screen-2xl mx-auto space-y-4 p-4">
      <header className="rounded-lg border bg-card p-4">
        <h1 className="text-lg font-bold">
          Comparación de paisajes sonoros entre sitios
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cinco índices ecoacústicos validados regionalmente (Müller et al.
          2023, <em>Nat. Comms.</em>; Kümmet et al. 2025, <em>Conserv. Lett.</em>),
          calculados por archivo y agrupados por tipo de hábitat. Cada punto
          es la mediana del despliegue durante la ventana diaria seleccionada.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div>
            <label
              htmlFor="acoustic-project-selector"
              className="block text-xs font-medium text-muted-foreground"
            >
              Proyecto
            </label>
            <form method="GET" className="mt-1">
              <input type="hidden" name="period" value={period} />
              <select
                id="acoustic-project-selector"
                name="project"
                defaultValue={selectedProject?.id ?? ""}
                className="rounded-md border bg-background px-2 py-1 text-sm"
                aria-label="Seleccionar proyecto"
              >
                {projects.length === 0 && (
                  <option value="">Sin proyectos</option>
                )}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <noscript>
                <button
                  type="submit"
                  className="ml-2 rounded-md border bg-background px-2 py-1 text-sm"
                >
                  Aplicar
                </button>
              </noscript>
            </form>
          </div>

          <nav
            aria-label="Ventana diaria"
            className="flex flex-wrap gap-1"
          >
            {(DIEL_PERIODS as readonly DielPeriod[])
              .filter((p) => p !== "other" || data.groups.some((g) => g.dielPeriod === "other"))
              .map((p) => {
                const isActive = p === period;
                const params = new URLSearchParams();
                if (selectedProject) {
                  params.set("project", String(selectedProject.id));
                }
                params.set("period", p);
                return (
                  <Link
                    key={p}
                    href={`/audio/indices?${params.toString()}`}
                    aria-current={isActive ? "page" : undefined}
                    className={`rounded-md border px-3 py-1.5 text-xs ${
                      isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : "bg-background hover:bg-accent"
                    }`}
                  >
                    {DIEL_PERIOD_LABELS[p]}
                  </Link>
                );
              })}
          </nav>

          <div className="ml-auto text-xs text-muted-foreground tabular-nums">
            {data.totalDeployments} despliegues con datos
          </div>
        </div>
      </header>

      {!selectedProject && (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          Sin proyectos de audio disponibles.
        </div>
      )}

      {selectedProject && data.groups.length === 0 && (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          Todavía no se han calculado índices acústicos para este proyecto.
          Inicia un cálculo desde la página de una instalación con audio.
        </div>
      )}

      {selectedProject && data.groups.length > 0 && filtered.length === 0 && (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          No hay datos en la ventana {DIEL_PERIOD_LABELS[period].toLowerCase()}.
        </div>
      )}

      {filtered.length > 0 &&
        INDEX_DESCRIPTORS.map((desc) => (
          <AcousticIndicesBoxPlot
            key={desc.key}
            groups={filtered}
            indexKey={desc.key}
            title={desc.title}
            description={desc.description}
            expectedDirection={desc.direction}
            unitLabel={desc.unit}
          />
        ))}
    </div>
  );
}
