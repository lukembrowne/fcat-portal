import { requireAdmin } from "@/lib/auth";
import { db } from "@/db";
import { processingJobs, type ProcessingJob } from "@/db/schema";
import { desc, inArray, asc } from "drizzle-orm";
import { projectJobsForDisplay, type JobDisplayRow } from "@/lib/job-display";
import { JOB_LABELS } from "@/lib/system-events";
import { SortIcon } from "@/components/sort-icon";
import { CancelJobButton } from "./cancel-job-button";
import type { JobType } from "@/lib/job-types";

export const dynamic = "force-dynamic";

const HISTORY_LIMIT = 50;

type HistorySortColumn = "completedAt" | "jobType" | "status" | "createdBy";
type SortDirection = "asc" | "desc";

const SORTABLE_COLUMNS: Record<HistorySortColumn, true> = {
  completedAt: true,
  jobType: true,
  status: true,
  createdBy: true,
};

const STATUS_LABEL: Record<ProcessingJob["status"], string> = {
  pending: "En cola",
  processing: "Procesando",
  completed: "Completado",
  failed: "Falló",
  cancelled: "Cancelado",
};

const STATUS_BADGE: Record<ProcessingJob["status"], string> = {
  pending: "bg-amber-100 text-amber-900",
  processing: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-zinc-100 text-zinc-700",
};

function asString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-EC", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Guayaquil",
  });
}

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return "—";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

function jobLabel(jobType: string): string {
  return JOB_LABELS[jobType as JobType] ?? jobType;
}

function ProgressCell({ row }: { row: JobDisplayRow }) {
  if (row.status === "pending") return <span className="text-muted-foreground">—</span>;
  const total = row.totalImages || 0;
  const done = row.processedImages || 0;
  if (total === 0) return <span className="text-muted-foreground">{row.statusMessage ?? "—"}</span>;
  const pct = Math.min(100, Math.round((done / total) * 100));
  return (
    <div className="flex flex-col gap-1 min-w-[140px]">
      <div className="flex items-center justify-between text-xs">
        <span>
          {done.toLocaleString("es-EC")} / {total.toLocaleString("es-EC")}
        </span>
        <span className="text-muted-foreground">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-blue-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ProcessingJob["status"] }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function HistorySortableHeader({
  column,
  label,
  currentSort,
  currentDir,
}: {
  column: HistorySortColumn;
  label: string;
  currentSort: HistorySortColumn;
  currentDir: SortDirection;
}) {
  const isActive = currentSort === column;
  const nextDir: SortDirection = isActive && currentDir === "desc" ? "asc" : "desc";
  const sp = new URLSearchParams();
  sp.set("sortBy", column);
  sp.set("sortDir", nextDir);
  return (
    <th className="px-3 py-2 font-medium text-left">
      <a
        href={`/admin/jobs?${sp.toString()}`}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        {label}
        <SortIcon direction={isActive ? currentDir : false} />
      </a>
    </th>
  );
}

function ResultCell({ row }: { row: JobDisplayRow }) {
  if (row.errorMessage && (row.status === "failed" || row.status === "cancelled")) {
    return (
      <details className="max-w-md">
        <summary className="cursor-pointer text-xs text-destructive hover:underline">
          Ver mensaje
        </summary>
        <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground bg-muted/40 rounded p-2">
          {row.errorMessage}
        </pre>
      </details>
    );
  }
  return <span className="text-muted-foreground text-xs">—</span>;
}

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const rawSort = asString(params.sortBy);
  const sortBy: HistorySortColumn =
    rawSort && rawSort in SORTABLE_COLUMNS ? (rawSort as HistorySortColumn) : "completedAt";
  const sortDir: SortDirection = asString(params.sortDir) === "asc" ? "asc" : "desc";

  // Active section: pending + processing, FIFO (createdAt ASC, id ASC).
  const activeRows = await db
    .select()
    .from(processingJobs)
    .where(inArray(processingJobs.status, ["pending", "processing"]))
    .orderBy(asc(processingJobs.createdAt), asc(processingJobs.id));

  const activeDisplay = await projectJobsForDisplay(activeRows, /* canCancel */ true);

  // History section: completed/failed/cancelled, sortable.
  const sortCol = (() => {
    switch (sortBy) {
      case "completedAt":
        return processingJobs.completedAt;
      case "jobType":
        return processingJobs.jobType;
      case "status":
        return processingJobs.status;
      case "createdBy":
        return processingJobs.createdBy;
    }
  })();
  const order = sortDir === "asc" ? asc(sortCol) : desc(sortCol);

  const historyRows = await db
    .select()
    .from(processingJobs)
    .where(inArray(processingJobs.status, ["completed", "failed", "cancelled"]))
    .orderBy(order, desc(processingJobs.id))
    .limit(HISTORY_LIMIT);

  const historyDisplay = await projectJobsForDisplay(historyRows, false);

  // Pre-compute queue positions for pending rows. The single processing row
  // (if any) appears first; pending rows are numbered #1, #2, ...
  const pendingOrder = activeDisplay
    .filter((r) => r.status === "pending")
    .map((r) => r.jobId);

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Trabajos del sistema</h1>
        <p className="text-muted-foreground">
          Trabajos activos y en cola en todo el portal — cámaras trampa, audio,
          sincronización con Drive, compresión. Cancela trabajos individuales o
          revisa el historial reciente. Para el historial completo de eventos,
          ver{" "}
          <a href="/admin/activity" className="underline hover:text-foreground">
            Actividad del sistema
          </a>
          .
        </p>
      </div>

      <section>
        <h2 className="text-xl font-semibold mb-3">
          Activos{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({activeDisplay.length})
          </span>
        </h2>
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Tipo</th>
                <th className="px-3 py-2 font-medium">Trabajo</th>
                <th className="px-3 py-2 font-medium">Progreso</th>
                <th className="px-3 py-2 font-medium">Iniciado</th>
                <th className="px-3 py-2 font-medium">Por</th>
                <th className="px-3 py-2 font-medium w-[120px]">Acción</th>
              </tr>
            </thead>
            <tbody>
              {activeDisplay.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                    No hay trabajos activos ni en cola.
                  </td>
                </tr>
              )}
              {activeDisplay.map((row) => {
                const queuePos =
                  row.status === "pending"
                    ? pendingOrder.indexOf(row.jobId) + 1
                    : null;
                const canCancel = row.canCancel && row.jobType !== "drive_sync";
                return (
                  <tr key={row.jobId} className="border-t align-top">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">{jobLabel(row.jobType)}</span>
                        <StatusBadge status={row.status as ProcessingJob["status"]} />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col">
                        <span>{row.displayName}</span>
                        {queuePos !== null && (
                          <span className="text-xs text-muted-foreground">
                            #{queuePos} en cola
                          </span>
                        )}
                        {row.status === "processing" && row.statusMessage && (
                          <span className="text-xs text-muted-foreground">
                            {row.statusMessage}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <ProgressCell row={row} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                      {row.status === "processing"
                        ? formatTimestamp(row.startedAt)
                        : `Encolado ${formatTimestamp(row.createdAt)}`}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                      {row.createdBy ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {canCancel ? (
                        <CancelJobButton jobId={row.jobId} />
                      ) : (
                        <span
                          className="text-xs text-muted-foreground"
                          title={row.jobType === "drive_sync" ? "No cancelable" : ""}
                        >
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-3">
          Historial reciente{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (últimos {HISTORY_LIMIT})
          </span>
        </h2>
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <HistorySortableHeader
                  column="jobType"
                  label="Tipo"
                  currentSort={sortBy}
                  currentDir={sortDir}
                />
                <th className="px-3 py-2 font-medium">Trabajo</th>
                <HistorySortableHeader
                  column="status"
                  label="Estado"
                  currentSort={sortBy}
                  currentDir={sortDir}
                />
                <th className="px-3 py-2 font-medium">Progreso</th>
                <HistorySortableHeader
                  column="completedAt"
                  label="Finalizado"
                  currentSort={sortBy}
                  currentDir={sortDir}
                />
                <th className="px-3 py-2 font-medium">Duración</th>
                <HistorySortableHeader
                  column="createdBy"
                  label="Por"
                  currentSort={sortBy}
                  currentDir={sortDir}
                />
                <th className="px-3 py-2 font-medium">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {historyDisplay.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                    No hay trabajos finalizados.
                  </td>
                </tr>
              )}
              {historyDisplay.map((row) => (
                <tr key={row.jobId} className="border-t align-top">
                  <td className="px-3 py-2 whitespace-nowrap font-medium">
                    {jobLabel(row.jobType)}
                  </td>
                  <td className="px-3 py-2">{row.displayName}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={row.status as ProcessingJob["status"]} />
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-xs text-muted-foreground">
                      {row.totalImages > 0
                        ? `${row.processedImages.toLocaleString("es-EC")} / ${row.totalImages.toLocaleString("es-EC")}`
                        : "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                    {formatTimestamp(row.completedAt)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                    {formatDuration(row.startedAt, row.completedAt)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                    {row.createdBy ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <ResultCell row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

