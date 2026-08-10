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
import { SortIcon } from "@/components/sort-icon";
import {
  Search,
  RefreshCw,
  Loader2,
  Info,
  Download,
  ChevronRight,
  ChevronDown,
  Star,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DeploymentRow } from "./actions";
import { DeploymentRowActions } from "./deployment-row-actions";
import { BatchEditDialog } from "@/components/deployments/batch-edit-dialog";
import { GroupSelectAllCheckbox } from "@/components/deployments/group-select-all-checkbox";
import { BatchDeleteDialog } from "./batch-delete-dialog";
import { bulkUpdateMetadata } from "./actions";
import { enqueueDriveSyncJob } from "./drive-actions";
import { ProcessConfirmDialog } from "./process-confirm-dialog";
import type { ProjectGroup, StatusCounts } from "./page";
import { useRowRangeSelection } from "@/hooks/use-row-range-selection";

/** localStorage key for remembering which project groups the user has collapsed
 * on the Instalaciones page. Per-device, non-sensitive UI preference. */
const COLLAPSED_GROUPS_STORAGE_KEY = "fcat.cameratrap.collapsedProjects.v1";

/** localStorage key for the user's personal "starred" installations — a private,
 * per-browser work-tracking aid ("which ones am I working on / do next"). Stored
 * client-side only (no DB), so stars don't sync across devices. Orthogonal to the
 * deployment `status` pipeline field. */
const STARRED_STORAGE_KEY = "fcat.cameratrap.starredDeployments.v1";

/** Statuses where the deployment looks "done" but pending images may have
 * arrived after a re-scan. Drives the "+N pendientes" badge. */
const POST_PROCESS_STATUSES = new Set([
  "processed",
  "verified",
  "verified_empty",
]);

/**
 * Format a deployment's installation/retrieval date (`date_start`/`date_end`).
 * These are stored as `YYYY-MM-DD` strings, so `new Date(str)` would parse them
 * as UTC midnight and render one day early in es-EC (UTC-5). Build a local Date
 * from the parts instead. Returns "—" when missing/unparseable.
 */
function formatDeploymentDate(v: string | null): string {
  if (!v) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(v);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-EC", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Effective status for display/filtering. "Procesando" is derived from the live
 * isProcessing flag (active jobs), never from the stored status column. Falls
 * back to the lifecycle status, collapsing detection-less "processed" rows to
 * the "processed_empty" badge.
 */
function deploymentDisplayStatus(d: DeploymentRow): string {
  if (d.isProcessing) return "processing";
  if (d.status === "processed" && (d.totalDetections == null || d.totalDetections === 0)) {
    return "processed_empty";
  }
  return d.status;
}

/** Whether a deployment matches the selected status-filter dropdown value. */
function deploymentMatchesStatusFilter(d: DeploymentRow, filter: string): boolean {
  if (filter === "processing") return d.isProcessing;
  return !d.isProcessing && d.status === filter;
}

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
  const [sorting, setSorting] = useState<SortingState>([
    { id: "name", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // Shift+click range selection across the (filter-, group-, and collapse-aware)
  // visible row order. The hook keeps its own refs internally so the cell
  // renderer doesn't re-memo on every selection change.
  const rangeSelection = useRowRangeSelection<DeploymentRow>(setRowSelection);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [syncing, startSync] = useTransition();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [processDialogIds, setProcessDialogIds] = useState<number[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );
  // Hydrate collapsed-groups state from localStorage on mount. We can't read
  // localStorage during the initial render because this component is rendered
  // on the server first; doing so would cause a hydration mismatch. The brief
  // flash on first paint is the accepted tradeoff for keeping SSR.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setCollapsedGroups(new Set(parsed.filter((x): x is string => typeof x === "string")));
      }
    } catch {
      // Private mode, quota errors, or malformed JSON — fall back to default.
    }
  }, []);
  // Persist on every change. Cheap: it's a small array of project labels.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLLAPSED_GROUPS_STORAGE_KEY,
        JSON.stringify(Array.from(collapsedGroups))
      );
    } catch {
      // Ignore quota / private-mode errors.
    }
  }, [collapsedGroups]);
  // Personal "starred" installations, persisted to localStorage. Same SSR-safe
  // hydrate-on-mount pattern as collapsedGroups above: start empty (matching the
  // server render) and fill in after mount to avoid a hydration mismatch.
  const [starredIds, setStarredIds] = useState<Set<number>>(() => new Set());
  const [showOnlyStarred, setShowOnlyStarred] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STARRED_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setStarredIds(
          new Set(parsed.filter((x): x is number => typeof x === "number"))
        );
      }
    } catch {
      // Private mode, quota errors, or malformed JSON — fall back to empty.
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STARRED_STORAGE_KEY,
        JSON.stringify(Array.from(starredIds))
      );
    } catch {
      // Ignore quota / private-mode errors.
    }
  }, [starredIds]);
  const toggleStar = useCallback((id: number) => {
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const [lastSyncAt, setLastSyncAt] = useState<string | null>(lastDriveSyncAt);
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
      data = data.filter((d) => deploymentMatchesStatusFilter(d, statusFilter));
    }
    if (showOnlyStarred) {
      data = data.filter((d) => starredIds.has(d.id));
    }
    return data;
  }, [initialDeployments, statusFilter, showOnlyStarred, starredIds]);

  // Build filtered groups from the server-provided groups + client filters
  const filteredGroups = useMemo(() => {
    return groups
      .map((g) => {
        let deps = g.deployments;
        if (statusFilter) {
          deps = deps.filter((d) => deploymentMatchesStatusFilter(d, statusFilter));
        }
        if (showOnlyStarred) {
          deps = deps.filter((d) => starredIds.has(d.id));
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
  }, [groups, statusFilter, globalFilter, showOnlyStarred, starredIds]);

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
            onClick={rangeSelection.onCheckboxClick}
            onCheckedChange={(value) =>
              rangeSelection.handleCheckedChange(row, !!value)
            }
            aria-label="Seleccionar fila (mantén Shift para seleccionar un rango)"
          />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
      },
      {
        id: "starred",
        // Accessor returns 1 for starred so the column sorts starred-first on the
        // first (descending) click. sortDescFirst makes that the default direction.
        accessorFn: (d) => (starredIds.has(d.id) ? 1 : 0),
        sortDescFirst: true,
        header: () => (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Star className="h-4 w-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                <p className="text-xs leading-relaxed">
                  Marca tus instalaciones (las que estás revisando o quieres
                  revisar pronto). Es una marca personal de este navegador.
                  Ordena por esta columna o usa &quot;Solo destacadas&quot; para
                  verlas juntas.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        cell: ({ row }) => {
          const id = row.original.id;
          const isStarred = starredIds.has(id);
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleStar(id);
              }}
              className="flex items-center justify-center text-muted-foreground transition-colors hover:text-amber-500"
              aria-label={
                isStarred ? "Quitar de destacadas" : "Marcar como destacada"
              }
              title={
                isStarred ? "Quitar de destacadas" : "Marcar como destacada"
              }
            >
              <Star
                className={`h-4 w-4 ${isStarred ? "fill-amber-400 text-amber-400" : ""}`}
              />
            </button>
          );
        },
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
        accessorKey: "dateStart",
        header: "Instalación",
        cell: ({ getValue }) => (
          <span className="tabular-nums whitespace-nowrap text-muted-foreground">
            {formatDeploymentDate(getValue<string | null>())}
          </span>
        ),
        enableGlobalFilter: false,
      },
      {
        accessorKey: "dateEnd",
        header: "Recuperación",
        cell: ({ getValue }) => (
          <span className="tabular-nums whitespace-nowrap text-muted-foreground">
            {formatDeploymentDate(getValue<string | null>())}
          </span>
        ),
        enableGlobalFilter: false,
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
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="no_data" type="deployment" /> Cámara sin archivos (confirmado)</span>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        cell: ({ row }) => {
          const d = row.original;
          const displayStatus = deploymentDisplayStatus(d);
          const showProgress = !d.isProcessing &&
            (d.status === "processed" || d.status === "verified") &&
            d.totalIdentifications != null && d.totalIdentifications > 0;
          const imgs = d.totalImages;
          const vids = d.totalVideos;
          const hasImgs = imgs != null && imgs > 0;
          const hasVids = vids != null && vids > 0;
          const totalPending = (d.pendingImageCount ?? 0) + (d.pendingVideoCount ?? 0);
          const showPending =
            totalPending > 0 && POST_PROCESS_STATUSES.has(d.status);
          const filesText = [
            hasImgs ? `${imgs.toLocaleString()} img` : null,
            hasVids ? `${vids.toLocaleString()} vid` : null,
          ]
            .filter(Boolean)
            .join(", ");
          const metaParts = [
            showProgress ? `${d.reviewedCount ?? 0}/${d.totalIdentifications} revisadas` : null,
            filesText || null,
          ].filter(Boolean);
          return (
            <div className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1">
                <StatusBadge status={displayStatus} type="deployment" />
                {d.excludedCamera && (
                  <span className="inline-flex items-center rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                    Excluida
                  </span>
                )}
              </span>
              {(metaParts.length > 0 || showPending) && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                  {metaParts.length > 0 && <span>{metaParts.join(" · ")}</span>}
                  {showPending && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
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
              )}
            </div>
          );
        },
      },
      {
        id: "compression",
        // Sort by fraction compressed; deployments with no compressible JPEGs
        // sort last in both directions (sortUndefined: "last").
        accessorFn: (d) =>
          d.compressibleImageCount > 0
            ? d.compressedImageCount / d.compressibleImageCount
            : undefined,
        sortUndefined: "last",
        header: () => (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1">
                  Compresión
                  <Info className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                <p className="text-xs leading-relaxed">
                  Imágenes JPEG comprimidas a calidad 85 (las originales se
                  preservan como revisiones en Drive). Comprimir las
                  instalaciones pendientes acelera la carga durante la
                  anotación. Ordena por esta columna para ver primero lo que
                  falta por comprimir.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        cell: ({ row }) => {
          const d = row.original;
          const total = d.compressibleImageCount;
          const done = d.compressedImageCount;
          if (total === 0)
            return <span className="text-muted-foreground">—</span>;
          const pct = Math.round((done / total) * 100);
          const full = done >= total;
          const cls = full
            ? "bg-emerald-100 text-emerald-800"
            : done === 0
              ? "bg-muted text-muted-foreground"
              : "bg-amber-100 text-amber-800";
          return (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums ${cls}`}
              title={`${done.toLocaleString()} de ${total.toLocaleString()} imágenes JPEG comprimidas (${pct}%)`}
            >
              {full
                ? "Comprimida"
                : `${done.toLocaleString()}/${total.toLocaleString()}`}
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
  }, [canEdit, isAdmin, rangeSelection, starredIds, toggleStar]);

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

  // Set of row IDs that pass the active global filter; drives both grouped
  // rendering and the visibleOrderedIds memo below.
  const filteredRowIds = useMemo(() => {
    return new Set(table.getFilteredRowModel().rows.map((r) => r.id));
  }, [table]);

  // Flat ordered list of currently visible deployment IDs, in the same order
  // they render: across groups, skipping collapsed ones, respecting global
  // filter. Drives the shift+click range selection.
  const visibleOrderedIds = useMemo(() => {
    const ids: number[] = [];
    for (const group of sortedGroups) {
      if (collapsedGroups.has(group.projectLabel)) continue;
      for (const dep of group.deployments) {
        if (filteredRowIds.has(String(dep.id))) ids.push(dep.id);
      }
    }
    return ids;
  }, [sortedGroups, collapsedGroups, filteredRowIds]);
  rangeSelection.setVisibleOrderedIds(visibleOrderedIds);

  /**
   * Enqueue a background drive_sync job. The actual work (folder discovery,
   * image scan, ODK match, count refresh) runs server-side; the floating
   * progress widget shows live progress and survives navigation.
   */
  const triggerSync = (cameraTrapProjectId?: number) => {
    startSync(async () => {
      setSyncMessage(null);
      const result = await enqueueDriveSyncJob(cameraTrapProjectId);
      if (!result.success) {
        setSyncMessage(`Error: ${result.error}`);
        return;
      }
      const scopeLabel = cameraTrapProjectId
        ? distinctProjects.find((p) => p.id === cameraTrapProjectId)?.name ?? "proyecto"
        : "todos los proyectos";
      setSyncMessage(
        `Sincronización iniciada para ${scopeLabel}. Puedes seguir trabajando — el progreso se muestra en la esquina inferior derecha.`
      );
      setLastSyncAt(new Date().toISOString());
      window.dispatchEvent(new Event("job-started"));
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

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {canEdit && (
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="inline-flex">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => triggerSync()}
                      disabled={syncing}
                      className="rounded-r-none"
                    >
                      {syncing ? (
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4 mr-1.5" />
                      )}
                      Sincronizar con Drive
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="default"
                          size="sm"
                          disabled={syncing || distinctProjects.length === 0}
                          className="rounded-l-none border-l border-primary-foreground/20 px-2"
                          aria-label="Sincronizar un proyecto específico"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel className="text-xs">
                          Sincronizar solo…
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {distinctProjects.map((p) => (
                          <DropdownMenuItem
                            key={p.id}
                            onSelect={() => triggerSync(p.id)}
                          >
                            {p.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p className="text-xs leading-relaxed">
                    Inicia una sincronización en segundo plano: busca carpetas
                    nuevas en Google Drive, las vincula con formularios de ODK
                    y cuenta sus imágenes. Puedes navegar a otras páginas
                    mientras se ejecuta.
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
          <Button
            variant={showOnlyStarred ? "default" : "outline"}
            size="sm"
            onClick={() => setShowOnlyStarred((v) => !v)}
            className="h-9"
            aria-pressed={showOnlyStarred}
          >
            <Star
              className={`h-4 w-4 mr-1.5 ${showOnlyStarred ? "fill-current" : ""}`}
            />
            Solo destacadas
          </Button>

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
            <option value="no_data">Sin datos</option>
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

      {/* Sync message — brief banner; live progress lives in the floating widget */}
      {syncMessage && (
        <p className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">
          {syncMessage}
        </p>
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
                        header.column.id !== "select" && (
                          <SortIcon direction={header.column.getIsSorted()} />
                        )}
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
                const selectableDepIds = group.deployments
                  .filter((d) => filteredRowIds.has(String(d.id)))
                  .map((d) => d.id);

                return (
                  <Fragment key={group.projectLabel}>
                    {/* Group header row */}
                    <TableRow
                      className="bg-muted/30 hover:bg-muted/50 cursor-pointer border-b"
                      onClick={() => toggleGroup(group.projectLabel)}
                    >
                      <TableCell colSpan={columns.length} className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <GroupSelectAllCheckbox
                            groupDeploymentIds={selectableDepIds}
                            rowSelection={rowSelection}
                            setRowSelection={setRowSelection}
                            groupLabel={group.projectLabel}
                          />
                          <ChevronRight
                            className={`h-4 w-4 transition-transform shrink-0 ${!isCollapsed ? "rotate-90" : ""}`}
                          />
                          <span className="font-semibold text-sm">
                            {group.projectLabel}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {group.totalCount} instalaciones
                          </span>
                          <GroupStatusChips counts={group.counts} />
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
                            className={`group/row cursor-pointer hover:bg-muted/50 ${dep.excludedCamera ? "opacity-50" : ""}`}
                            data-state={row.getIsSelected() ? "selected" : undefined}
                            onClick={(e) => {
                              // React synthetic events bubble through the React tree, not the DOM.
                              // Clicks inside portaled dialogs/menus rendered by row children would
                              // otherwise fire this navigation. Ignore anything not in the row's DOM.
                              if (!e.currentTarget.contains(e.target as Node)) return;
                              router.push(`/camera-trap/${dep.id}`);
                            }}
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
        {(globalFilter || statusFilter || showOnlyStarred) && " (filtradas)"}
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
            onSubmit={bulkUpdateMetadata}
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

/**
 * Per-project status breakdown shown in the group header, mirroring the page's
 * top summary strip. Chips with a zero value are hidden to keep the header clean.
 */
function GroupStatusChips({ counts }: { counts: StatusCounts }) {
  const chips: { label: string; value: number; dotClass: string; valueClass: string; extra?: string }[] = [
    {
      label: "Por Procesar",
      value: counts.porProcesar,
      dotClass: "bg-blue-600",
      valueClass: "text-blue-700",
      extra: counts.sinArchivos > 0 ? `${counts.sinArchivos} sin archivos` : undefined,
    },
    { label: "Procesando", value: counts.procesando, dotClass: "bg-yellow-500", valueClass: "text-yellow-600" },
    { label: "Por Revisar", value: counts.porRevisar, dotClass: "bg-orange-500", valueClass: "text-orange-600" },
    { label: "Verificadas", value: counts.verificadas, dotClass: "bg-emerald-600", valueClass: "text-emerald-700" },
    { label: "Sin datos", value: counts.sinDatos, dotClass: "bg-slate-400", valueClass: "text-slate-600" },
  ];

  const visible = chips.filter((c) => c.value > 0);
  if (visible.length === 0) return null;

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {visible.map((c) => (
        <span key={c.label} className="inline-flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${c.dotClass}`} aria-hidden />
          <span className="text-muted-foreground">{c.label}</span>
          <span className={`font-semibold tabular-nums ${c.valueClass}`}>{c.value}</span>
          {c.extra && <span className="text-muted-foreground">({c.extra})</span>}
        </span>
      ))}
    </span>
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
