import { requireAdmin } from "@/lib/auth";
import { SortIcon } from "@/components/sort-icon";
import {
  listSharedDrives,
  type SortColumn,
  type SortDirection,
  type SharedDriveRow,
  type ThresholdConfig,
} from "./actions";
import {
  RegisterDriveButton,
  ReconcileNowButton,
  RowActions,
} from "./client";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  registering: "bg-blue-100 text-blue-800",
  active: "bg-green-100 text-green-800",
  "read-only": "bg-amber-100 text-amber-900",
  unreachable: "bg-red-100 text-red-800",
};

const STATUS_LABEL: Record<string, string> = {
  registering: "Registrando",
  active: "Activo",
  "read-only": "Solo lectura",
  unreachable: "Inaccesible",
};

function asString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function SortableHeader({
  column,
  label,
  currentSort,
  currentDir,
  className,
}: {
  column: SortColumn;
  label: string;
  currentSort: SortColumn;
  currentDir: SortDirection;
  className?: string;
}) {
  const isActive = currentSort === column;
  const nextDir = isActive && currentDir === "desc" ? "asc" : "desc";
  const sp = new URLSearchParams();
  sp.set("sortBy", column);
  sp.set("sortDir", nextDir);
  return (
    <th className={`px-3 py-2 font-medium ${className ?? ""}`}>
      <a
        href={`/admin/shared-drives?${sp.toString()}`}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        {label}
        <SortIcon direction={isActive ? currentDir : false} />
      </a>
    </th>
  );
}

function fillColor(pct: number, t: ThresholdConfig): string {
  if (pct >= t.stop) return "bg-red-500";
  if (pct >= t.hard) return "bg-orange-500";
  if (pct >= t.soft) return "bg-amber-400";
  return "bg-green-500";
}

function CapacityBar({ row, thresholds }: { row: SharedDriveRow; thresholds: ThresholdConfig }) {
  const pct = Math.min(1, row.fillPct);
  return (
    <div className="min-w-[160px]">
      <div className="h-2 w-full overflow-hidden rounded bg-muted">
        <div
          className={`h-full ${fillColor(row.fillPct, thresholds)}`}
          style={{ width: `${(pct * 100).toFixed(1)}%` }}
        />
      </div>
      <div className="mt-1 text-xs text-muted-foreground tabular-nums">
        {row.effectiveCount.toLocaleString("es-EC")} /{" "}
        {row.itemCap.toLocaleString("es-EC")} ({(row.fillPct * 100).toFixed(1)}%)
        {row.pendingReservationsCount > 0 && (
          <span className="ml-1 italic">
            · {row.pendingReservationsCount.toLocaleString("es-EC")} reservados
          </span>
        )}
      </div>
      {row.trashedCount > 0 && (
        <div className="mt-0.5 text-xs text-amber-700 tabular-nums">
          🗑️ {row.trashedCount.toLocaleString("es-EC")} en papelera —
          purgables para recuperar espacio
        </div>
      )}
    </div>
  );
}

function formatTs(ts: string | null): string {
  if (!ts) return "—";
  // Stored as SQLite datetime('now') (UTC, "YYYY-MM-DD HH:MM:SS").
  const d = new Date(ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("es-EC", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Guayaquil",
  });
}

export default async function AdminSharedDrivesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const sortBy = (asString(params.sortBy) ?? "reconciledCount") as SortColumn;
  const sortDir: SortDirection = asString(params.sortDir) === "asc" ? "asc" : "desc";
  const includeArchived = asString(params.archived) === "1";

  const { rows, thresholds, projects, projectCapacities } = await listSharedDrives({
    sortBy,
    sortDir,
    includeArchived,
  });

  const anyNearCap = rows.some((r) => r.fillPct >= thresholds.hard);
  const provisionAhead = projectCapacities.filter((c) => c.provisionAhead);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">Shared Drives</h1>
          <p className="text-muted-foreground max-w-3xl">
            Registro de Shared Drives de Google para la distribución de
            instalaciones por capacidad. Cada drive sirve a un proyecto; un
            proyecto grande puede ocupar varios drives. Las nuevas instalaciones
            se crean en el drive más lleno del proyecto que aún esté por debajo
            del {(thresholds.hard * 100).toFixed(0)}%. Las lecturas funcionan en
            cualquier drive sin importar su estado. El conteo incluye los
            elementos en la papelera (igual que el límite de Google), así que
            vaciar la papelera de un drive libera capacidad.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <ReconcileNowButton />
          <RegisterDriveButton projects={projects} />
        </div>
      </div>

      {projectCapacities.length > 0 && (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projectCapacities.map((c) => (
            <div
              key={c.projectId}
              className={`rounded border p-3 ${c.provisionAhead ? "border-amber-400 bg-amber-50" : "bg-muted/20"}`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{c.projectName}</span>
                <span className="text-xs text-muted-foreground">
                  {c.activeDriveCount}/{c.driveCount} drive(s) activos
                </span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted">
                <div
                  className={`h-full ${fillColor(c.fillPct, thresholds)}`}
                  style={{ width: `${(Math.min(1, c.fillPct) * 100).toFixed(1)}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                {c.effectiveTotal.toLocaleString("es-EC")} /{" "}
                {c.capTotal.toLocaleString("es-EC")} ({(c.fillPct * 100).toFixed(1)}%)
              </div>
              {c.provisionAhead && (
                <div className="mt-2 text-xs font-medium text-amber-800">
                  ⚠️ Aprovisiona el próximo drive para este proyecto.
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(anyNearCap || provisionAhead.length > 0) && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          ⚠️ {provisionAhead.length > 0
            ? `Estos proyectos necesitan un nuevo drive pronto: ${provisionAhead.map((c) => c.projectName).join(", ")}.`
            : `Uno o más drives superan el umbral crítico (${(thresholds.hard * 100).toFixed(0)}%).`}{" "}
          Crea un nuevo Shared Drive, agrégale la cuenta de servicio y regístralo
          aquí (asignándolo al proyecto correcto).
        </div>
      )}

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <SortableHeader column="name" label="Nombre" currentSort={sortBy} currentDir={sortDir} />
              <th className="px-3 py-2 font-medium">Proyecto</th>
              <SortableHeader column="status" label="Estado" currentSort={sortBy} currentDir={sortDir} />
              <SortableHeader column="reconciledCount" label="Capacidad" currentSort={sortBy} currentDir={sortDir} />
              <th className="px-3 py-2 font-medium">Drive ID</th>
              <SortableHeader column="lastReconciledAt" label="Reconciliado" currentSort={sortBy} currentDir={sortDir} />
              <th className="px-3 py-2 font-medium">Salud</th>
              <th className="px-3 py-2 font-medium text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  No hay Shared Drives registrados. Usa “Registrar drive”.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{row.name}</div>
                  <div className="text-xs text-muted-foreground font-mono">{row.id}</div>
                  {row.archivedAt && (
                    <span className="text-xs italic text-muted-foreground">archivado</span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {row.projectName ? (
                    <span className="text-sm">{row.projectName}</span>
                  ) : (
                    <span className="text-xs italic text-amber-700">sin proyecto</span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span
                    className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[row.status] ?? "bg-gray-100 text-gray-800"}`}
                  >
                    {STATUS_LABEL[row.status] ?? row.status}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <CapacityBar row={row} thresholds={thresholds} />
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {row.driveId.slice(0, 12)}…
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  {formatTs(row.lastReconciledAt)}
                </td>
                <td className="px-3 py-2 text-xs">
                  {row.lastHealthStatus === "ok" ? (
                    <span className="text-green-700">ok</span>
                  ) : row.lastHealthStatus ? (
                    <span className="text-red-700" title={row.lastHealthStatus}>
                      {row.lastHealthStatus.slice(0, 40)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <RowActions
                    id={row.id}
                    name={row.name}
                    status={row.status}
                    archived={!!row.archivedAt}
                    projects={projects}
                    projectId={row.cameraTrapProjectId}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-sm">
        {includeArchived ? (
          <a href="/admin/shared-drives" className="underline hover:text-foreground">
            Ocultar archivados
          </a>
        ) : (
          <a href="/admin/shared-drives?archived=1" className="underline hover:text-foreground">
            Mostrar archivados
          </a>
        )}
      </div>
    </div>
  );
}
