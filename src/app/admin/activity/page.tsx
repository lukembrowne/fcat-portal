import { requireAdmin } from "@/lib/auth";
import { EVENT_SOURCES, EVENT_SEVERITIES } from "@/db/schema";
import { listEvents } from "./actions";

export const dynamic = "force-dynamic";

const SOURCE_LABELS: Record<(typeof EVENT_SOURCES)[number], string> = {
  admin: "Administración",
  audio: "Audio",
  "biochoco-tools": "BioChoco · Herramientas",
  "biochoco-resultados": "BioChoco · Resultados",
  "camera-trap": "Cámaras Trampa",
  climate: "Clima",
  cron: "Tareas programadas",
  finance: "Finanzas",
  odk: "ODK",
};

const SEVERITY_LABELS: Record<(typeof EVENT_SEVERITIES)[number], string> = {
  info: "Información",
  success: "Éxito",
  warn: "Advertencia",
  error: "Error",
};

const SEVERITY_BADGE: Record<(typeof EVENT_SEVERITIES)[number], string> = {
  info: "bg-blue-100 text-blue-800",
  success: "bg-green-100 text-green-800",
  warn: "bg-amber-100 text-amber-900",
  error: "bg-red-100 text-red-800",
};

function asString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("es-EC", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Guayaquil",
  });
}

function formatDuration(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(0);
  return `${m} m ${rem} s`;
}

export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const filters = {
    source: asString(params.source),
    eventType: asString(params.eventType),
    severity: asString(params.severity),
    actorEmail: asString(params.actorEmail),
    from: asString(params.from),
    to: asString(params.to),
    q: asString(params.q),
    page: params.page ? parseInt(asString(params.page) ?? "1", 10) || 1 : 1,
  };

  const result = await listEvents(filters);

  const prevPage = filters.page > 1 ? filters.page - 1 : null;
  const nextPage = result.hasNext ? filters.page + 1 : null;

  const buildPageHref = (page: number) => {
    const sp = new URLSearchParams();
    if (filters.source) sp.set("source", filters.source);
    if (filters.eventType) sp.set("eventType", filters.eventType);
    if (filters.severity) sp.set("severity", filters.severity);
    if (filters.actorEmail) sp.set("actorEmail", filters.actorEmail);
    if (filters.from) sp.set("from", filters.from);
    if (filters.to) sp.set("to", filters.to);
    if (filters.q) sp.set("q", filters.q);
    if (page > 1) sp.set("page", String(page));
    const qs = sp.toString();
    return qs ? `?${qs}` : "";
  };

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Actividad del sistema</h1>
        <p className="text-muted-foreground">
          Registro unificado de tareas programadas, acciones administrativas,
          cargas de datos y otros eventos significativos. Para los registros
          crudos en vivo, ver{" "}
          <a href="/admin/logs" className="underline hover:text-foreground">
            Registros del sistema
          </a>
          .
        </p>
      </div>

      <form
        method="GET"
        className="mb-6 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3 rounded border p-4 bg-muted/30"
      >
        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground mb-1">Origen</span>
          <select
            name="source"
            defaultValue={filters.source ?? ""}
            className="rounded border px-2 py-1 text-sm bg-background"
          >
            <option value="">Todos</option>
            {EVENT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground mb-1">Severidad</span>
          <select
            name="severity"
            defaultValue={filters.severity ?? ""}
            className="rounded border px-2 py-1 text-sm bg-background"
          >
            <option value="">Todas</option>
            {EVENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground mb-1">Tipo de evento</span>
          <input
            type="text"
            name="eventType"
            defaultValue={filters.eventType ?? ""}
            placeholder="p. ej. cron_db_backup"
            className="rounded border px-2 py-1 text-sm bg-background"
          />
        </label>

        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground mb-1">Actor (correo)</span>
          <input
            type="text"
            name="actorEmail"
            defaultValue={filters.actorEmail ?? ""}
            placeholder="usuario@…"
            className="rounded border px-2 py-1 text-sm bg-background"
          />
        </label>

        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground mb-1">Desde</span>
          <input
            type="date"
            name="from"
            defaultValue={filters.from ?? ""}
            className="rounded border px-2 py-1 text-sm bg-background"
          />
        </label>

        <label className="flex flex-col text-sm">
          <span className="text-muted-foreground mb-1">Hasta</span>
          <input
            type="date"
            name="to"
            defaultValue={filters.to ?? ""}
            className="rounded border px-2 py-1 text-sm bg-background"
          />
        </label>

        <label className="flex flex-col text-sm md:col-span-2 lg:col-span-4">
          <span className="text-muted-foreground mb-1">Buscar (resumen)</span>
          <input
            type="text"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Texto contenido en el resumen…"
            className="rounded border px-2 py-1 text-sm bg-background"
          />
        </label>

        <div className="flex items-end gap-2 md:col-span-1 lg:col-span-2">
          <button
            type="submit"
            className="rounded bg-primary text-primary-foreground px-3 py-1 text-sm font-medium hover:opacity-90"
          >
            Filtrar
          </button>
          <a
            href="/admin/activity"
            className="rounded border px-3 py-1 text-sm hover:bg-muted"
          >
            Limpiar
          </a>
        </div>
      </form>

      <div className="mb-3 text-sm text-muted-foreground">
        {result.total === 0
          ? "Sin eventos para los filtros actuales."
          : `${result.total.toLocaleString("es-EC")} evento${
              result.total === 1 ? "" : "s"
            } · página ${result.page}`}
      </div>

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Cuándo</th>
              <th className="px-3 py-2 font-medium">Severidad</th>
              <th className="px-3 py-2 font-medium">Origen</th>
              <th className="px-3 py-2 font-medium">Tipo</th>
              <th className="px-3 py-2 font-medium">Resumen</th>
              <th className="px-3 py-2 font-medium">Actor</th>
              <th className="px-3 py-2 font-medium">Duración</th>
              <th className="px-3 py-2 font-medium">Detalles</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  No hay eventos para mostrar.
                </td>
              </tr>
            )}
            {result.rows.map((row) => (
              <tr key={row.id} className="border-t align-top">
                <td className="px-3 py-2 whitespace-nowrap">
                  {formatTimestamp(row.occurredAt)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[row.severity]}`}
                  >
                    {SEVERITY_LABELS[row.severity]}
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {SOURCE_LABELS[row.source] ?? row.source}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{row.eventType}</td>
                <td className="px-3 py-2">{row.summary}</td>
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  {row.actorEmail ?? <span className="italic">sistema</span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  {formatDuration(row.durationMs) ?? "—"}
                </td>
                <td className="px-3 py-2">
                  {row.details ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        Ver JSON
                      </summary>
                      <pre className="mt-2 max-w-md overflow-auto rounded bg-muted/40 p-2 text-xs">
                        {(() => {
                          try {
                            return JSON.stringify(JSON.parse(row.details), null, 2);
                          } catch {
                            return row.details;
                          }
                        })()}
                      </pre>
                    </details>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <div className="text-muted-foreground">
          Mostrando{" "}
          {result.rows.length === 0
            ? 0
            : (filters.page - 1) * result.pageSize + 1}
          –{(filters.page - 1) * result.pageSize + result.rows.length} de{" "}
          {result.total.toLocaleString("es-EC")}
        </div>
        <div className="flex gap-2">
          {prevPage !== null ? (
            <a
              href={buildPageHref(prevPage)}
              className="rounded border px-3 py-1 hover:bg-muted"
            >
              ← Anterior
            </a>
          ) : (
            <span className="rounded border px-3 py-1 text-muted-foreground opacity-50">
              ← Anterior
            </span>
          )}
          {nextPage !== null ? (
            <a
              href={buildPageHref(nextPage)}
              className="rounded border px-3 py-1 hover:bg-muted"
            >
              Siguiente →
            </a>
          ) : (
            <span className="rounded border px-3 py-1 text-muted-foreground opacity-50">
              Siguiente →
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
