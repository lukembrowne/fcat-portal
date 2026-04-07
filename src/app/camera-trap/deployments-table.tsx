"use client";

import { useState, useMemo, useCallback, useTransition, useEffect, Fragment } from "react";
import { useRouter } from "next/navigation";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type RowSelectionState,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/status-badge";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  RefreshCw,
  Loader2,
  Info,
  Download,
  ChevronRight,
  AlertCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DeploymentRow } from "./actions";
import { DeploymentRowActions } from "./deployment-row-actions";
import { BatchEditDialog } from "./batch-edit-dialog";
import { BatchDeleteDialog } from "./batch-delete-dialog";
import { syncWithDrive, scanDeploymentImages } from "./drive-actions";
import { matchOdkDeployments } from "./odk-actions";
import { ProcessConfirmDialog } from "./process-confirm-dialog";
import type { ProjectGroup } from "./page";

/** Deployment statuses that are excluded from global Drive re-scan because a
 * human has already signed off on the contents. Operators can still scan these
 * manually via the per-row "Buscar imágenes" action. */
const SKIP_RESCAN_STATUSES = new Set(["verified", "verified_empty"]);

/** Statuses where the deployment looks "done" but pending images may have
 * arrived after a re-scan. Drives the "+N pendientes" badge. */
const POST_PROCESS_STATUSES = new Set([
  "processed",
  "verified",
  "verified_empty",
]);

export interface CtProject {
  id: number;
  name: string;
}

interface DeploymentsTableProps {
  groups: ProjectGroup[];
  deployments: DeploymentRow[];
  distinctProjects: CtProject[];
  canEdit: boolean;
  isAdmin: boolean;
  /** ISO string of the last successful Drive sync, or null if never. */
  lastDriveSyncAt: string | null;
}

export function DeploymentsTable({
  groups,
  deployments: initialDeployments,
  distinctProjects,
  canEdit,
  isAdmin,
  lastDriveSyncAt,
}: DeploymentsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [syncing, startSync] = useTransition();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [processDialogIds, setProcessDialogIds] = useState<number[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(lastDriveSyncAt);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  // Tick every 30s so the relative "hace X" label stays fresh without a refresh.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const router = useRouter();

  // Refresh table data when a job reaches a terminal state
  useEffect(() => {
    const handleJobsUpdated = () => {
      router.refresh();
    };
    window.addEventListener("jobs-updated", handleJobsUpdated);
    return () => window.removeEventListener("jobs-updated", handleJobsUpdated);
  }, [router]);

  // Apply status filter to the flat data for TanStack
  const filteredData = useMemo(() => {
    let data = initialDeployments;
    if (statusFilter) {
      data = data.filter((d) => d.status === statusFilter);
    }
    return data;
  }, [initialDeployments, statusFilter]);

  // Build filtered groups from the server-provided groups + client filters
  const filteredGroups = useMemo(() => {
    return groups
      .map((g) => {
        let deps = g.deployments;
        if (statusFilter) {
          deps = deps.filter((d) => d.status === statusFilter);
        }
        if (globalFilter) {
          const lower = globalFilter.toLowerCase();
          deps = deps.filter(
            (d) =>
              d.name.toLowerCase().includes(lower) ||
              (d.projectLabel?.toLowerCase().includes(lower) ?? false) ||
              (d.siteName?.toLowerCase().includes(lower) ?? false)
          );
        }
        return { ...g, deployments: deps, totalCount: deps.length };
      })
      .filter((g) => g.deployments.length > 0);
  }, [groups, statusFilter, globalFilter]);

  const toggleGroup = useCallback((projectLabel: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectLabel)) {
        next.delete(projectLabel);
      } else {
        next.add(projectLabel);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setCollapsedGroups(new Set()), []);
  const collapseAll = useCallback(
    () => setCollapsedGroups(new Set(groups.map((g) => g.projectLabel))),
    [groups]
  );

  const columns = useMemo<ColumnDef<DeploymentRow>[]>(() => {
    const cols: ColumnDef<DeploymentRow>[] = [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(!!value)
            }
            aria-label="Seleccionar todo"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Seleccionar fila"
            onClick={(e) => e.stopPropagation()}
          />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
      },
    ];

    cols.push(
      {
        accessorKey: "name",
        header: "Nombre",
        cell: ({ getValue }) => (
          <span className="font-medium whitespace-normal">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: "siteName",
        header: "Sitio",
        cell: ({ getValue }) => (
          <span className="whitespace-normal">
            {getValue<string | null>() || "—"}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: () => (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1">
                  Estado
                  <Info className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs bg-popover text-popover-foreground border shadow-md p-3">
                <div className="flex flex-col gap-1.5 text-xs">
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="scanned" type="deployment" /> Lista para procesar con ML</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="processing" type="deployment" /> Modelo ML analizando</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="processed" type="deployment" /> Tiene detecciones por revisar</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="processed_empty" type="deployment" /> Procesada, sin detecciones</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="verified" type="deployment" /> Revisada por investigador</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="verified_empty" type="deployment" /> Sin detecciones, confirmada</span>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        cell: ({ row }) => {
          const d = row.original;
          const displayStatus = d.status === "processed" && (d.totalDetections == null || d.totalDetections === 0)
            ? "processed_empty"
            : d.status;
          const showProgress = (d.status === "processed" || d.status === "verified") &&
            d.totalIdentifications != null && d.totalIdentifications > 0;
          return (
            <span className="inline-flex items-center gap-1">
              <StatusBadge status={displayStatus} type="deployment" />
              {showProgress && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {d.reviewedCount ?? 0}/{d.totalIdentifications} revisadas
                </span>
              )}
              {d.excluded && (
                <span className="inline-flex items-center rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                  Excluida
                </span>
              )}
            </span>
          );
        },
      },
      {
        accessorKey: "totalImages",
        header: "Archivos",
        cell: ({ row }) => {
          const dep = row.original;
          const imgs = dep.totalImages;
          const vids = dep.totalVideos;
          const hasImgs = imgs != null && imgs > 0;
          const hasVids = vids != null && vids > 0;
          const totalPending = (dep.pendingImageCount ?? 0) + (dep.pendingVideoCount ?? 0);
          const showPending =
            totalPending > 0 && POST_PROCESS_STATUSES.has(dep.status);
          if (!hasImgs && !hasVids && !showPending) return "—";
          return (
            <span className="inline-flex items-center gap-1.5">
              <span className="tabular-nums">
                {hasImgs ? `${imgs.toLocaleString()} img` : ""}
                {hasImgs && hasVids ? ", " : ""}
                {hasVids ? `${vids.toLocaleString()} vid` : ""}
                {!hasImgs && !hasVids ? "—" : ""}
              </span>
              {showPending && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800"
                        onClick={(e) => e.stopPropagation()}
                      >
                        +{totalPending} pendientes
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <p className="text-xs leading-relaxed">
                        Archivos nuevos detectados que aún no han sido procesados.
                        Usa &quot;Procesar nuevas&quot; en el menú de acciones para
                        incluirlos sin perder las verificaciones existentes.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        accessorKey: "totalDetections",
        header: "Detecciones",
        cell: ({ getValue }) => {
          const v = getValue<number | null>();
          if (v == null) return "—";
          return (
            <span className="tabular-nums">
              {v > 0 ? v.toLocaleString() : "0"}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        accessorKey: "distinctSpecies",
        header: "Especies",
        cell: ({ getValue }) => {
          const v = getValue<number | null>();
          if (v == null) return "—";
          return (
            <span className="tabular-nums">
              {v > 0 ? v.toLocaleString() : "0"}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        accessorKey: "lastProcessedAt",
        header: "Último Proceso",
        cell: ({ getValue }) => {
          const v = getValue<Date | null>();
          if (!v) return "—";
          return (
            <span className="tabular-nums text-muted-foreground">
              {new Date(v).toLocaleDateString("es-EC", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <DeploymentRowActions
            deployment={row.original}
            canEdit={canEdit}
            isAdmin={isAdmin}
          />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
      },
    );

    return cols;
  }, [canEdit, isAdmin]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter, rowSelection },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: true,
    getRowId: (row) => String(row.id),
  });

  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const selectedIds = selectedRows.map((r) => r.original.id);

  // Map of deployment id → index in TanStack's sorted row model.
  // Recomputed whenever sorting state changes because getRowModel() returns
  // a new rows array.
  const sortedRows = table.getRowModel().rows;
  const sortedRowOrder = useMemo(() => {
    const map = new Map<number, number>();
    sortedRows.forEach((r, i) => map.set(r.original.id, i));
    return map;
  }, [sortedRows]);

  // Apply the sorted order within each group so grouping stays intact
  // but rows inside each group respect the active column sort.
  const sortedGroups = useMemo(() => {
    return filteredGroups.map((g) => ({
      ...g,
      deployments: [...g.deployments].sort(
        (a, b) =>
          (sortedRowOrder.get(a.id) ?? 0) - (sortedRowOrder.get(b.id) ?? 0)
      ),
    }));
  }, [filteredGroups, sortedRowOrder]);

  const handleSync = () => {
    startSync(async () => {
      setSyncMessage(null);
      setSyncProgress(null);
      setSyncErrors([]);
      setErrorsExpanded(false);
      const messages: string[] = [];
      const collectedErrors: string[] = [];

      // Step 1: Sync with Drive (discovers new folders, auto-scans them)
      const result = await syncWithDrive();
      if (!result.success) {
        setSyncMessage(`Error: ${result.error}`);
        setSyncErrors([result.error]);
        setErrorsExpanded(true);
        return;
      }

      const { created, errors } = result.data;
      collectedErrors.push(...errors);
      if (created.length > 0) {
        // Step 2: Auto-match new deployments with ODK
        const odkResult = await matchOdkDeployments(
          created.map((d) => d.id)
        );
        const matchCount = odkResult.success
          ? odkResult.data.matched.length
          : 0;
        messages.push(
          `${created.length} nueva(s) instalación(es). ${matchCount} vinculada(s) con ODK.`
        );
        if (errors.length > 0) {
          messages.push(`${errors.length} error(es) de sincronización.`);
        }
      }

      // Step 3: Re-scan all deployments except those a human has already verified.
      // Verified statuses are excluded so adding new images doesn't muddy the
      // human sign-off — operators can still trigger a manual scan per row.
      const needsScan = initialDeployments.filter(
        (d) => d.driveFolderId && !SKIP_RESCAN_STATUSES.has(d.status)
      );

      if (needsScan.length > 0) {
        let scanned = 0;
        let scanErrors = 0;
        let depsWithNewMedia = 0;
        let totalNewMedia = 0;

        for (let i = 0; i < needsScan.length; i++) {
          const dep = needsScan[i];
          setSyncProgress({
            current: i + 1,
            total: needsScan.length,
            label: dep.name,
          });
          const beforeImages = dep.totalImages ?? 0;
          const scanResult = await scanDeploymentImages(dep.id);
          if (scanResult.success) {
            scanned++;
            const delta = scanResult.data.imageCount - beforeImages;
            if (delta > 0) {
              depsWithNewMedia++;
              totalNewMedia += delta;
            }
          } else {
            scanErrors++;
            collectedErrors.push(
              `${dep.projectLabel ? `${dep.projectLabel} / ` : ""}${dep.name}: ${scanResult.error}`
            );
          }
        }

        const newMediaSuffix =
          depsWithNewMedia > 0
            ? ` ${depsWithNewMedia} con imágenes nuevas (+${totalNewMedia}).`
            : "";
        const errorSuffix = scanErrors > 0 ? ` ${scanErrors} error(es).` : "";
        messages.push(
          `${scanned} de ${needsScan.length} instalación(es) re-escaneada(s).${newMediaSuffix}${errorSuffix}`
        );

        // Mention skipped (verified) deployments so the count adds up to the table total.
        const skippedVerified = initialDeployments.filter(
          (d) => d.driveFolderId && SKIP_RESCAN_STATUSES.has(d.status)
        ).length;
        if (skippedVerified > 0) {
          messages.push(`${skippedVerified} verificada(s) (omitida(s)).`);
        }
      }

      setSyncProgress(null);
      setSyncMessage(
        messages.length > 0
          ? messages.join(" ")
          : "Todo sincronizado. No hay cambios."
      );
      setSyncErrors(collectedErrors);
      if (collectedErrors.length > 0) setErrorsExpanded(true);
      setLastSyncAt(new Date().toISOString());
    });
  };

  const handleBatchProcess = () => {
    setProcessDialogIds(selectedIds);
  };

  const handleProcessStarted = () => {
    setRowSelection({});
    window.dispatchEvent(new Event("job-started"));
  };

  const handleExport = async () => {
    const allSelected = table.getFilteredSelectedRowModel().rows;
    const processedStatuses = new Set(["processed", "verified", "verified_empty"]);
    const valid = allSelected.filter((r) => processedStatuses.has(r.original.status));
    const excluded = allSelected.length - valid.length;

    if (valid.length === 0) {
      setSyncMessage("No hay instalaciones procesadas para exportar.");
      return;
    }

    if (excluded > 0) {
      setSyncMessage(
        `${excluded} instalación(es) sin procesar no incluida(s) en la exportación.`
      );
    }

    setExporting(true);
    try {
      const ids = valid.map((r) => r.original.id).join(",");
      const response = await fetch(`/api/camera-trap/export?ids=${ids}`);

      if (!response.ok) {
        let msg = "Error al exportar";
        try {
          msg = (await response.json()).error || msg;
        } catch {}
        setSyncMessage(msg);
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `camtrap-dp-${new Date().toISOString().split("T")[0]}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);

      setSyncMessage(
        `Exportación completada: ${valid.length} instalación(es) en formato Camtrap DP.`
      );
    } catch {
      setSyncMessage("Error al exportar los datos.");
    } finally {
      setExporting(false);
    }
  };

  // Build a set of row IDs that pass the global filter for grouped rendering
  const filteredRowIds = useMemo(() => {
    return new Set(table.getFilteredRowModel().rows.map((r) => r.id));
  }, [table]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {canEdit && (
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleSync}
                    disabled={syncing}
                  >
                    {syncing ? (
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-1.5" />
                    )}
                    Sincronizar con Drive
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p className="text-xs leading-relaxed">
                    Busca carpetas nuevas en Google Drive, las vincula con
                    formularios de ODK y cuenta sus imágenes. Úsalo cuando hayas
                    subido instalaciones nuevas o cambiado datos en ODK.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span className="text-xs text-muted-foreground tabular-nums">
              {lastSyncAt
                ? `Última sincronización ${formatRelativeEs(lastSyncAt)}`
                : "Nunca sincronizado"}
            </span>
          </div>
        )}

        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={expandAll} className="text-xs">
            Expandir
          </Button>
          <Button variant="ghost" size="sm" onClick={collapseAll} className="text-xs">
            Colapsar
          </Button>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Todos los estados</option>
            <option value="unscanned">Por Procesar (nueva)</option>
            <option value="scanned">Por Procesar</option>
            <option value="processing">Procesando</option>
            <option value="processed">Por Revisar</option>
            <option value="verified">Verificada</option>
            <option value="verified_empty">Vacía (verificada)</option>
          </select>

          <div className="relative w-[260px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por nombre, proyecto, sitio..."
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
      </div>

      {/* Sync progress */}
      {syncProgress && (
        <div className="bg-muted/50 px-3 py-2.5 rounded-md space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground inline-flex items-center gap-1.5 min-w-0">
              <Loader2 className="h-3 w-3 animate-spin shrink-0" />
              <span className="truncate">
                Buscando archivos en{" "}
                <span className="font-medium text-foreground">
                  {syncProgress.label}
                </span>
              </span>
            </span>
            <span className="tabular-nums text-muted-foreground shrink-0">
              {syncProgress.current} / {syncProgress.total}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all duration-200 ease-out"
              style={{
                width: `${Math.min(100, (syncProgress.current / syncProgress.total) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Sync message */}
      {syncMessage && !syncProgress && (
        <p className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">
          {syncMessage}
        </p>
      )}

      {/* Sync errors detail */}
      {syncErrors.length > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5">
          <button
            type="button"
            onClick={() => setErrorsExpanded((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-destructive/10 rounded-md"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="font-medium">
              {syncErrors.length} error{syncErrors.length === 1 ? "" : "es"} durante la sincronización
            </span>
            <ChevronRight
              className={`h-4 w-4 ml-auto transition-transform ${errorsExpanded ? "rotate-90" : ""}`}
            />
          </button>
          {errorsExpanded && (
            <ul className="border-t border-destructive/20 px-3 py-2 space-y-1 text-xs text-destructive/90 max-h-64 overflow-y-auto font-mono">
              {syncErrors.map((err, i) => (
                <li key={i} className="break-words">
                  • {err}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Selection toolbar */}
      {selectedRows.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-muted/50 rounded-md">
          <span className="text-sm font-medium">
            {selectedRows.length} seleccionado(s)
          </span>
          <div className="flex gap-2">
            {canEdit && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleBatchProcess}
                >
                  Procesar Seleccionados
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setBatchEditOpen(true)}
                >
                  Editar Seleccionados
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setBatchDeleteOpen(true)}
                >
                  Eliminar
                </Button>
              </>
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleExport}
                    disabled={exporting}
                  >
                    {exporting ? (
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-1.5" />
                    )}
                    {exporting ? "Exportando..." : "Exportar Camtrap DP"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Descargar un paquete de datos estandarizado (Camtrap DP)
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRowSelection({})}
          >
            Deseleccionar
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border overflow-auto">
        <Table className="text-xs">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={
                      header.column.getCanSort()
                        ? "cursor-pointer select-none"
                        : ""
                    }
                    onClick={
                      header.column.id !== "select"
                        ? header.column.getToggleSortingHandler()
                        : undefined
                    }
                  >
                    <span className="flex items-center gap-1">
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                      {header.column.getCanSort() &&
                        header.column.id !== "select" &&
                        ({
                          asc: <ArrowUp className="h-3.5 w-3.5" />,
                          desc: <ArrowDown className="h-3.5 w-3.5" />,
                        }[header.column.getIsSorted() as string] ?? (
                          <ArrowUpDown className="h-3.5 w-3.5 opacity-30" />
                        ))}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {filteredGroups.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-center text-muted-foreground py-8"
                >
                  No hay instalaciones.{" "}
                  {canEdit &&
                    "Usa \"Sincronizar con Drive\" para buscar carpetas."}
                </TableCell>
              </TableRow>
            ) : (
              sortedGroups.map((group) => {
                const isCollapsed = collapsedGroups.has(group.projectLabel);
                const actionable = group.deployments.filter((d) =>
                  ["unscanned", "scanned", "processing", "processed"].includes(d.status)
                ).length;

                return (
                  <Fragment key={group.projectLabel}>
                    {/* Group header row */}
                    <TableRow
                      className="bg-muted/30 hover:bg-muted/50 cursor-pointer border-b"
                      onClick={() => toggleGroup(group.projectLabel)}
                    >
                      <TableCell colSpan={columns.length} className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <ChevronRight
                            className={`h-4 w-4 transition-transform shrink-0 ${!isCollapsed ? "rotate-90" : ""}`}
                          />
                          <span className="font-semibold text-sm">
                            {group.projectLabel}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {group.totalCount} instalaciones
                          </span>
                          {actionable > 0 && (
                            <span className="text-xs font-medium text-orange-600">
                              {actionable} pendiente{actionable !== 1 ? "s" : ""}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {/* Deployment rows within group */}
                    {!isCollapsed &&
                      group.deployments.map((dep) => {
                        const row = table.getRowModel().rowsById[String(dep.id)];
                        if (!row) return null;
                        // Skip rows that don't match global filter
                        if (!filteredRowIds.has(row.id)) return null;
                        return (
                          <TableRow
                            key={row.id}
                            className={`group/row cursor-pointer hover:bg-muted/50 ${dep.excluded ? "opacity-50" : ""}`}
                            data-state={row.getIsSelected() ? "selected" : undefined}
                            onClick={() => router.push(`/camera-trap/${dep.id}`)}
                          >
                            {row.getVisibleCells().map((cell) => (
                              <TableCell key={cell.id}>
                                {flexRender(
                                  cell.column.columnDef.cell,
                                  cell.getContext()
                                )}
                              </TableCell>
                            ))}
                          </TableRow>
                        );
                      })}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Row count */}
      <p className="text-sm text-muted-foreground">
        {table.getFilteredRowModel().rows.length} instalaciones
        {(globalFilter || statusFilter) && " (filtradas)"}
      </p>

      {/* Batch dialogs */}
      {canEdit && (
        <>
          <BatchEditDialog
            open={batchEditOpen}
            onOpenChange={setBatchEditOpen}
            selectedIds={selectedIds}
            selectedCount={selectedRows.length}
            distinctProjects={distinctProjects}
            onComplete={() => setRowSelection({})}
          />
          <BatchDeleteDialog
            open={batchDeleteOpen}
            onOpenChange={setBatchDeleteOpen}
            selectedIds={selectedIds}
            selectedCount={selectedRows.length}
            onComplete={() => setRowSelection({})}
          />
          <ProcessConfirmDialog
            deploymentIds={processDialogIds}
            isAdmin={isAdmin}
            onClose={() => setProcessDialogIds(null)}
            onStarted={handleProcessStarted}
          />
        </>
      )}
    </div>
  );
}

/** Compact Spanish relative time, e.g. "hace 5 min", "hace 2 h", "hace 3 d". */
function formatRelativeEs(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return "hace unos segundos";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr} h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `hace ${diffDay} d`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `hace ${diffMo} mes${diffMo === 1 ? "" : "es"}`;
  const diffYr = Math.floor(diffDay / 365);
  return `hace ${diffYr} año${diffYr === 1 ? "" : "s"}`;
}
