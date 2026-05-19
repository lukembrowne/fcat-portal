"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/status-badge";
import { formatDuration } from "@/lib/format-duration";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortIcon } from "@/components/sort-icon";
import { DeleteJobDialog } from "../delete-job-dialog";
import { BatchDeleteJobsDialog } from "../batch-delete-jobs-dialog";

type SortKey =
  | "deployment"
  | "status"
  | "images"
  | "detections"
  | "species"
  | "date"
  | "duration";
type SortDir = "asc" | "desc";

export interface ResultsJob {
  id: number;
  status: string;
  totalImages: number;
  processedImages: number;
  failedImages: number;
  detectorModel: string | null;
  classifierModel: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  deployment: { id: number; name: string; siteName: string | null } | null;
  detectionsCount: number;
  speciesCount: number;
  verifiedCount: number;
  errorMessage: string | null;
}

interface Props {
  jobs: ResultsJob[];
  canDelete: boolean;
}

export function ResultsTable({ jobs, canDelete }: Props) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [deleteJobId, setDeleteJobId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);

  const sorted = useMemo(() => {
    return [...jobs].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "deployment":
          cmp = (a.deployment?.name || "").localeCompare(
            b.deployment?.name || ""
          );
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "images":
          cmp = a.processedImages - b.processedImages;
          break;
        case "detections":
          cmp = a.detectionsCount - b.detectionsCount;
          break;
        case "species":
          cmp = a.speciesCount - b.speciesCount;
          break;
        case "date": {
          const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          cmp = ta - tb;
          break;
        }
        case "duration": {
          cmp = getDurationMs(a) - getDurationMs(b);
          break;
        }
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [jobs, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function SortHeader({ label, col }: { label: string; col: SortKey }) {
    const active = sortKey === col;
    return (
      <TableHead
        className="cursor-pointer select-none hover:bg-muted/50"
        onClick={() => toggleSort(col)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          <SortIcon direction={active ? sortDir : false} />
        </span>
      </TableHead>
    );
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    return d.toLocaleDateString("es-EC", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });
  }

  function getDurationMs(job: ResultsJob): number {
    if (!job.startedAt || !job.completedAt) return 0;
    return new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime();
  }

  function renderDuration(job: ResultsJob): string {
    const ms = getDurationMs(job);
    if (ms <= 0) return "—";
    return formatDuration(ms);
  }

  const allSelected =
    sorted.length > 0 && sorted.every((j) => selectedIds.has(j.id));

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sorted.map((j) => j.id)));
    }
  }

  function toggleOne(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <>
      {canDelete && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-2 mb-3">
          <span className="text-sm font-medium">
            {selectedIds.size} seleccionado{selectedIds.size > 1 ? "s" : ""}
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setBatchDeleteOpen(true)}
          >
            Eliminar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelectedIds(new Set())}
          >
            Deseleccionar
          </Button>
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              {canDelete && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Seleccionar todos"
                  />
                </TableHead>
              )}
              <SortHeader label="Instalación" col="deployment" />
              <SortHeader label="Estado" col="status" />
              <SortHeader label="Imágenes" col="images" />
              <SortHeader label="Detecciones" col="detections" />
              <SortHeader label="Especies" col="species" />
              <TableHead>Modelos</TableHead>
              <SortHeader label="Fecha" col="date" />
              <SortHeader label="Duración" col="duration" />
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((job) => (
              <TableRow
                key={job.id}
                className="cursor-pointer"
                data-state={selectedIds.has(job.id) ? "selected" : undefined}
                onClick={(e) => {
                  // React synthetic events bubble through the React tree, not the DOM.
                  // Clicks inside portaled dialogs/menus rendered by row children would
                  // otherwise fire this navigation. Ignore anything not in the row's DOM.
                  if (!e.currentTarget.contains(e.target as Node)) return;
                  router.push(`/camera-trap/results/${job.id}`);
                }}
              >
                {canDelete && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(job.id)}
                      onCheckedChange={() => toggleOne(job.id)}
                      aria-label={`Seleccionar trabajo #${job.id}`}
                    />
                  </TableCell>
                )}
                <TableCell className="font-medium">
                  {job.deployment?.name || "Instalación desconocida"}
                  {job.deployment?.siteName && (
                    <div className="text-xs text-muted-foreground font-normal">{job.deployment.siteName}</div>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={job.status} type="job" />
                  {job.status === "failed" && job.errorMessage && (
                    <div
                      className="mt-1 max-w-[240px] truncate text-xs text-destructive"
                      title={job.errorMessage}
                    >
                      {job.errorMessage.split("\n")[0]}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  {job.processedImages}/{job.totalImages}
                  {job.failedImages > 0 && (
                    <span className="text-destructive text-xs ml-1">
                      ({job.failedImages} fallidas)
                    </span>
                  )}
                </TableCell>
                <TableCell>{job.detectionsCount}</TableCell>
                <TableCell>{job.speciesCount}</TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                  {job.detectorModel || "—"}
                  {job.classifierModel && ` / ${job.classifierModel}`}
                </TableCell>
                <TableCell className="text-sm">
                  {formatDate(job.createdAt)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {renderDuration(job)}
                </TableCell>
                <TableCell
                  className="text-right"
                  onClick={(e) => e.stopPropagation()}
                >
                  {canDelete && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteJobId(job.id)}
                    >
                      Eliminar
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <DeleteJobDialog
        jobId={deleteJobId}
        onClose={() => setDeleteJobId(null)}
        onDeleted={() => setDeleteJobId(null)}
      />

      <BatchDeleteJobsDialog
        open={batchDeleteOpen}
        onOpenChange={setBatchDeleteOpen}
        selectedIds={[...selectedIds]}
        selectedCount={selectedIds.size}
        onComplete={() => setSelectedIds(new Set())}
      />
    </>
  );
}
