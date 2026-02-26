"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Minus,
  Search,
  ChevronUp,
  ChevronDown,
  RefreshCw,
  Loader2,
  FolderPlus,
  Upload,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { ScheduleRow, ScheduleStatus } from "@/lib/schedule-types";
import type { UploadStatus } from "@/lib/drive-client";
import { refreshSingleUploadCount, saveUploadSnapshot, type DriveStatusResult } from "./actions";
import { recreateDriveFolder } from "./drive-folder-actions";

// --- Helpers ---

const SHORT_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function formatShortDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function driveLink(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

function formatRelativeTime(unixTimestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixTimestamp;
  if (diff < 60) return "ahora";
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  return `hace ${Math.floor(diff / 86400)}d`;
}

/** Build initial driveCache from cached schedule data */
function buildInitialCache(schedule: ScheduleRow[]): Map<string, DriveStatusResult> {
  const cache = new Map<string, DriveStatusResult>();
  for (const row of schedule) {
    if (row.uploadCountsCheckedAt != null) {
      cache.set(row.deploymentId, {
        deploymentId: row.deploymentId,
        uploads: {
          camarasTrampas: row.uploadCameraCount ?? null,
          grabadoresDeAudio: row.uploadAudioCount ?? null,
          ibutton: row.uploadIbuttonCount ?? null,
          subfolderIds: {
            camarasTrampas: row.uploadCameraFolderId ?? null,
            grabadoresDeAudio: row.uploadAudioFolderId ?? null,
            ibutton: row.uploadIbuttonFolderId ?? null,
          },
        },
      });
    }
  }
  return cache;
}

// --- Status display components ---

const STATUS_LABELS: Record<ScheduleStatus, { label: string; className: string }> = {
  scheduled: { label: "Programado", className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  deployed: { label: "Instalado", className: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" },
  retrieved: { label: "Recuperado", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300" },
};

function StatusBadge({ status }: { status: ScheduleStatus }) {
  const config = STATUS_LABELS[status] ?? STATUS_LABELS.scheduled;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${config.className}`}>{config.label}</span>;
}

/** Cell for a data type column: shows file count (if verified) + "Subir" link to subfolder */
function DataTypeCell({
  parentFolderLink,
  driveStatus,
  dataTypeKey,
}: {
  parentFolderLink: string | null;
  driveStatus: DriveStatusResult | undefined;
  dataTypeKey: keyof Omit<UploadStatus, "subfolderIds">;
}) {
  if (!parentFolderLink) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Minus className="size-4" />
      </span>
    );
  }

  const uploads = driveStatus?.uploads;
  const error = driveStatus?.error;
  const count = uploads ? uploads[dataTypeKey] : undefined;
  const subfolderId = uploads?.subfolderIds?.[dataTypeKey];
  const href = subfolderId ? driveLink(subfolderId) : parentFolderLink;

  return (
    <div className="inline-flex items-center gap-1.5">
      {/* Count indicator (only after verification) */}
      {driveStatus && (
        error || count === null || count === undefined ? (
          <span className="inline-flex items-center gap-0.5 text-amber-600" title={error ?? "No se pudo verificar"}>
            <AlertTriangle className="size-3.5" />
          </span>
        ) : count > 0 ? (
          <span className="inline-flex items-center gap-0.5 text-emerald-600" title={`${count} archivo${count !== 1 ? "s" : ""}`}>
            <CheckCircle2 className="size-3.5" />
            <span className="text-xs">{count}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-0.5 text-red-500" title="Sin archivos">
            <XCircle className="size-3.5" />
            <span className="text-xs">0</span>
          </span>
        )
      )}

      {/* "Subir" link */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 dark:text-blue-400 dark:hover:text-blue-300 dark:hover:bg-blue-950/30 transition-colors"
        title="Abrir carpeta en Google Drive para subir datos"
      >
        <Upload className="size-3" />
        Subir
      </a>
    </div>
  );
}

// --- Sorting ---

type SortField = "deploymentId" | "siteId" | "status" | "actualDeployDate" | "actualRetrieveDate" | "uploadCameraCount" | "uploadAudioCount" | "uploadIbuttonCount";
type SortDir = "asc" | "desc";

const NUMERIC_FIELDS = new Set<SortField>(["uploadCameraCount", "uploadAudioCount", "uploadIbuttonCount"]);

function sortRows(rows: ScheduleRow[], field: SortField, dir: SortDir): ScheduleRow[] {
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (NUMERIC_FIELDS.has(field)) {
      const av = (a[field] as number | null | undefined) ?? -1;
      const bv = (b[field] as number | null | undefined) ?? -1;
      cmp = av - bv;
    } else {
      cmp = (a[field] as string ?? "").localeCompare(b[field] as string ?? "");
    }
    return dir === "asc" ? cmp : -cmp;
  });
}

function SortButton({ field, current, dir, onSort }: {
  field: SortField;
  current: SortField;
  dir: SortDir;
  onSort: (field: SortField) => void;
}) {
  const active = field === current;
  return (
    <button onClick={() => onSort(field)} className="inline-flex items-center gap-0.5 hover:text-foreground">
      {active ? (
        dir === "asc" ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />
      ) : (
        <ChevronUp className="size-3 opacity-30" />
      )}
    </button>
  );
}

// --- Main component ---

interface UploadStatusTableProps {
  schedule: ScheduleRow[];
}

export function UploadStatusTable({ schedule }: UploadStatusTableProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("deploymentId");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [driveCache, setDriveCache] = useState<Map<string, DriveStatusResult>>(() => buildInitialCache(schedule));
  const [progress, setProgress] = useState<{ current: number; total: number; action: "verify" | "recreate" } | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const handleSort = useCallback((field: SortField) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortDir("asc");
      }
      return field;
    });
  }, []);

  // Filter and sort
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const base = q
      ? schedule.filter(
          (r) =>
            r.deploymentId.toLowerCase().includes(q) ||
            r.siteId.toLowerCase().includes(q) ||
            r.siteName.toLowerCase().includes(q)
        )
      : schedule;
    return sortRows(base, sortField, sortDir);
  }, [schedule, search, sortField, sortDir]);

  // Summary stats
  const stats = useMemo(() => {
    const retrieved = schedule.filter((r) => r.status === "retrieved");
    const withData = retrieved.filter(
      (r) =>
        (r.uploadCameraCount ?? 0) > 0 ||
        (r.uploadAudioCount ?? 0) > 0 ||
        (r.uploadIbuttonCount ?? 0) > 0
    );
    return {
      total: schedule.length,
      retrieved: retrieved.length,
      withData: withData.length,
    };
  }, [schedule]);

  // Staleness indicator: earliest checkedAt among all rows, or null if none checked
  const stalenessText = useMemo(() => {
    const checkedTimestamps = schedule
      .map((r) => r.uploadCountsCheckedAt)
      .filter((t): t is number => t != null);
    if (checkedTimestamps.length === 0) return "Sin verificar";
    const earliest = Math.min(...checkedTimestamps);
    return `Último conteo: ${formatRelativeTime(earliest)}`;
  }, [schedule, driveCache]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh ALL deployments — sequential with progress
  const refreshAll = useCallback(async () => {
    const allWithFolders = schedule.filter((r) => r.driveFolderLink);
    if (allWithFolders.length === 0) return;

    setProgress({ current: 0, total: allWithFolders.length, action: "verify" });
    try {
      for (let i = 0; i < allWithFolders.length; i++) {
        const { deploymentId, driveFolderLink } = allWithFolders[i];
        const result = await refreshSingleUploadCount(deploymentId, driveFolderLink);
        setDriveCache((prev) => {
          const next = new Map(prev);
          next.set(result.deploymentId, result);
          return next;
        });
        setProgress({ current: i + 1, total: allWithFolders.length, action: "verify" });
      }
      // Save daily snapshot after all counts are refreshed
      await saveUploadSnapshot();
      // Re-run server components so summary cards update
      router.refresh();
    } finally {
      setProgress(null);
    }
  }, [schedule, router]);

  // Refresh a single row
  const refreshOne = useCallback(async (deploymentId: string, driveFolderLink: string) => {
    setRefreshingId(deploymentId);
    try {
      const result = await refreshSingleUploadCount(deploymentId, driveFolderLink);
      setDriveCache((prev) => {
        const next = new Map(prev);
        next.set(result.deploymentId, result);
        return next;
      });
      router.refresh();
    } finally {
      setRefreshingId(null);
    }
  }, [router]);

  // Recreate Drive folders for deployments with errors
  const handleRecreate = useCallback(async () => {
    const failedIds = filtered
      .filter((r) => driveCache.get(r.deploymentId)?.error)
      .map((r) => r.deploymentId);

    if (failedIds.length === 0) return;

    setProgress({ current: 0, total: failedIds.length, action: "recreate" });
    try {
      for (let i = 0; i < failedIds.length; i++) {
        const result = await recreateDriveFolder(failedIds[i]);
        if (result.success) {
          setDriveCache((prev) => {
            const next = new Map(prev);
            next.delete(failedIds[i]);
            return next;
          });
        }
        setProgress({ current: i + 1, total: failedIds.length, action: "recreate" });
      }
    } finally {
      setProgress(null);
    }
    // Re-verify to show fresh counts
    refreshAll();
  }, [filtered, driveCache, refreshAll]);

  const failedCount = filtered.filter((r) => driveCache.get(r.deploymentId)?.error).length;

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Estado de Datos</h1>
        <p className="text-muted-foreground mt-1">
          Usa los botones <span className="font-medium text-blue-600 dark:text-blue-400">&ldquo;Subir&rdquo;</span> para abrir la carpeta de Google Drive donde debes subir cada tipo de dato.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por instalación o sitio..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshAll}
          disabled={progress !== null}
          title="Consulta Google Drive para contar cuántos archivos hay en cada carpeta. Ejecutar después de subir nuevos datos."
        >
          {progress?.action === "verify" ? <Loader2 className="size-4 animate-spin mr-1.5" /> : <RefreshCw className="size-4 mr-1.5" />}
          {progress?.action === "verify" ? `Actualizando ${progress.current}/${progress.total}...` : "Actualizar Conteo"}
        </Button>
        <span className="text-sm text-muted-foreground">
          {stalenessText}
        </span>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">Total</p>
          <p className="text-xl font-bold">{stats.total}</p>
        </div>
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">Recuperadas</p>
          <p className="text-xl font-bold">{stats.retrieved} <span className="text-sm font-normal text-muted-foreground">/ {stats.total}</span></p>
        </div>
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">Con datos</p>
          <p className="text-xl font-bold">{stats.withData} <span className="text-sm font-normal text-muted-foreground">/ {stats.retrieved}</span></p>
        </div>
      </div>

      {failedCount > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-3 mb-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-amber-800 dark:text-amber-200">
              {failedCount} instalaci{failedCount > 1 ? "ones" : "ón"} no se pudo{failedCount > 1 ? "ieron" : ""} verificar en Google Drive.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRecreate}
              disabled={progress !== null}
            >
              {progress?.action === "recreate" ? <Loader2 className="size-4 animate-spin mr-1.5" /> : <FolderPlus className="size-4 mr-1.5" />}
              {progress?.action === "recreate" ? `Recreando ${progress.current}/${progress.total}...` : "Recrear Carpetas"}
            </Button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-lg border p-8 text-center text-muted-foreground">
          {search ? "No se encontraron instalaciones." : "No hay instalaciones en el cronograma."}
        </div>
      ) : (
        <>
          <div className="rounded-lg border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      Instalación
                      <SortButton field="deploymentId" current={sortField} dir={sortDir} onSort={handleSort} />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      Sitio
                      <SortButton field="siteId" current={sortField} dir={sortDir} onSort={handleSort} />
                    </span>
                  </TableHead>
                  <TableHead className="text-center">
                    <span className="inline-flex items-center gap-1">
                      Estado
                      <SortButton field="status" current={sortField} dir={sortDir} onSort={handleSort} />
                    </span>
                  </TableHead>
                  <TableHead className="text-center whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      F. Instalación
                      <SortButton field="actualDeployDate" current={sortField} dir={sortDir} onSort={handleSort} />
                    </span>
                  </TableHead>
                  <TableHead className="text-center whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      F. Recuperación
                      <SortButton field="actualRetrieveDate" current={sortField} dir={sortDir} onSort={handleSort} />
                    </span>
                  </TableHead>
                  <TableHead className="text-center">
                    <span className="inline-flex items-center gap-1">
                      Cámaras
                      <SortButton field="uploadCameraCount" current={sortField} dir={sortDir} onSort={handleSort} />
                    </span>
                  </TableHead>
                  <TableHead className="text-center">
                    <span className="inline-flex items-center gap-1">
                      Audio
                      <SortButton field="uploadAudioCount" current={sortField} dir={sortDir} onSort={handleSort} />
                    </span>
                  </TableHead>
                  <TableHead className="text-center">
                    <span className="inline-flex items-center gap-1">
                      iButton
                      <SortButton field="uploadIbuttonCount" current={sortField} dir={sortDir} onSort={handleSort} />
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => {
                  const driveStatus = driveCache.get(row.deploymentId);
                  const parentLink = row.driveFolderLink || null;

                  return (
                    <TableRow key={row.deploymentId}>
                      <TableCell className="px-2">
                        {parentLink && (
                          <button
                            onClick={() => refreshOne(row.deploymentId, parentLink)}
                            disabled={progress !== null || refreshingId !== null}
                            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 p-1 rounded hover:bg-muted"
                            title="Actualizar conteo de esta instalación"
                          >
                            {refreshingId === row.deploymentId ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="size-3.5" />
                            )}
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">{row.deploymentId}</TableCell>
                      <TableCell>{row.siteName || row.siteId}</TableCell>
                      <TableCell className="text-center">
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-center text-sm whitespace-nowrap">
                        {formatShortDate(row.actualDeployDate)}
                      </TableCell>
                      <TableCell className="text-center text-sm whitespace-nowrap">
                        {formatShortDate(row.actualRetrieveDate)}
                      </TableCell>
                      <TableCell className="text-center">
                        <DataTypeCell
                          parentFolderLink={parentLink}
                          driveStatus={driveStatus}
                          dataTypeKey="camarasTrampas"
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <DataTypeCell
                          parentFolderLink={parentLink}
                          driveStatus={driveStatus}
                          dataTypeKey="grabadoresDeAudio"
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <DataTypeCell
                          parentFolderLink={parentLink}
                          driveStatus={driveStatus}
                          dataTypeKey="ibutton"
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

        </>
      )}
    </div>
  );
}
