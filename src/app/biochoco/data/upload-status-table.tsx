"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Minus,
  ExternalLink,
  Search,
  ChevronUp,
  ChevronDown,
  RefreshCw,
  Loader2,
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
import { checkDriveForDeployments, type DriveStatusResult } from "./actions";

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

function UploadCell({ count, error }: { count: number | null; error?: string }) {
  if (error || count === null) {
    return (
      <span className="inline-flex items-center gap-1 text-amber-600" title={error ?? "No se pudo verificar"}>
        <AlertTriangle className="size-4" />
        <span className="text-xs">Error</span>
      </span>
    );
  }
  if (count > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-600">
        <CheckCircle2 className="size-4" />
        <span className="text-xs">{count}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-red-500">
      <XCircle className="size-4" />
      <span className="text-xs">0</span>
    </span>
  );
}

function NoLinkCell() {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Minus className="size-4" />
    </span>
  );
}

function NotCheckedCell() {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span className="text-xs">—</span>
    </span>
  );
}

// --- Sorting ---

type SortField = "deploymentId" | "siteId" | "visitNumber" | "status";
type SortDir = "asc" | "desc";

function sortRows(rows: ScheduleRow[], field: SortField, dir: SortDir): ScheduleRow[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (field === "visitNumber") {
      cmp = a.visitNumber - b.visitNumber;
    } else {
      cmp = (a[field] ?? "").localeCompare(b[field] ?? "");
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

const PAGE_SIZE = 15;

interface UploadStatusTableProps {
  schedule: ScheduleRow[];
}

export function UploadStatusTable({ schedule }: UploadStatusTableProps) {
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("deploymentId");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(0);
  const [driveCache, setDriveCache] = useState<Map<string, DriveStatusResult>>(new Map());
  const [checking, startCheck] = useTransition();

  const handleSort = useCallback((field: SortField) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortDir("asc");
      }
      return field;
    });
    setPage(0);
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

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Check Drive for visible rows
  const checkVisibleRows = useCallback(() => {
    const toCheck = pageRows
      .filter((r) => r.driveFolderLink && !driveCache.has(r.deploymentId))
      .map((r) => ({ deploymentId: r.deploymentId, driveFolderLink: r.driveFolderLink }));

    if (toCheck.length === 0) return;

    startCheck(async () => {
      const result = await checkDriveForDeployments(toCheck);
      if (result.success) {
        setDriveCache((prev) => {
          const next = new Map(prev);
          for (const row of result.data) {
            next.set(row.deploymentId, row);
          }
          return next;
        });
      }
    });
  }, [pageRows, driveCache]);

  // Auto-check when page changes
  useEffect(() => {
    checkVisibleRows();
  }, [page, sortField, sortDir, search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Force re-check visible rows (ignore cache)
  const refreshVisible = useCallback(() => {
    const toCheck = pageRows
      .filter((r) => r.driveFolderLink)
      .map((r) => ({ deploymentId: r.deploymentId, driveFolderLink: r.driveFolderLink }));

    if (toCheck.length === 0) return;

    startCheck(async () => {
      const result = await checkDriveForDeployments(toCheck);
      if (result.success) {
        setDriveCache((prev) => {
          const next = new Map(prev);
          for (const row of result.data) {
            next.set(row.deploymentId, row);
          }
          return next;
        });
      }
    });
  }, [pageRows]);

  const failedCount = pageRows.filter((r) => driveCache.get(r.deploymentId)?.error).length;

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Estado de Datos</h1>
        <p className="text-muted-foreground mt-1">
          Estado de carga de datos en Google Drive por despliegue.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por despliegue o sitio..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="pl-9"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshVisible}
          disabled={checking}
        >
          {checking ? <Loader2 className="size-4 animate-spin mr-1.5" /> : <RefreshCw className="size-4 mr-1.5" />}
          Verificar Drive
        </Button>
        <span className="text-sm text-muted-foreground">
          {filtered.length} despliegue{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {failedCount > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-3 mb-4">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            {failedCount} despliegue{failedCount > 1 ? "s" : ""} no se pudo{failedCount > 1 ? "ieron" : ""} verificar en Google Drive.
          </p>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-lg border p-8 text-center text-muted-foreground">
          {search ? "No se encontraron despliegues." : "No hay despliegues en el cronograma."}
        </div>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      Despliegue
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
                      Visita
                      <SortButton field="visitNumber" current={sortField} dir={sortDir} onSort={handleSort} />
                    </span>
                  </TableHead>
                  <TableHead className="text-center">
                    <span className="inline-flex items-center gap-1">
                      Estado
                      <SortButton field="status" current={sortField} dir={sortDir} onSort={handleSort} />
                    </span>
                  </TableHead>
                  <TableHead className="text-center">Cámaras</TableHead>
                  <TableHead className="text-center">Audio</TableHead>
                  <TableHead className="text-center">iButton</TableHead>
                  <TableHead className="w-8"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => {
                  const driveStatus = driveCache.get(row.deploymentId);
                  const hasLink = !!row.driveFolderLink;
                  const uploads = driveStatus?.uploads;
                  const error = driveStatus?.error;

                  return (
                    <TableRow key={row.deploymentId}>
                      <TableCell className="font-medium">{row.deploymentId}</TableCell>
                      <TableCell>{row.siteName || row.siteId}</TableCell>
                      <TableCell className="text-center">{row.visitNumber}</TableCell>
                      <TableCell className="text-center">
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-center">
                        {!hasLink ? <NoLinkCell /> : !driveStatus ? <NotCheckedCell /> : uploads ? (
                          <UploadCell count={uploads.camarasTrampas} error={error} />
                        ) : (
                          <UploadCell count={null} error={error} />
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {!hasLink ? <NoLinkCell /> : !driveStatus ? <NotCheckedCell /> : uploads ? (
                          <UploadCell count={uploads.grabadoresDeAudio} error={error} />
                        ) : (
                          <UploadCell count={null} error={error} />
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {!hasLink ? <NoLinkCell /> : !driveStatus ? <NotCheckedCell /> : uploads ? (
                          <UploadCell count={uploads.ibutton} error={error} />
                        ) : (
                          <UploadCell count={null} error={error} />
                        )}
                      </TableCell>
                      <TableCell>
                        {row.driveFolderLink && (
                          <a
                            href={row.driveFolderLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                            title="Abrir carpeta en Drive"
                          >
                            <ExternalLink className="size-4" />
                          </a>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Anterior
              </Button>
              <span className="text-sm text-muted-foreground">
                Página {page + 1} de {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Siguiente
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
