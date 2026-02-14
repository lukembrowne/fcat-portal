"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DeleteJobDialog } from "../delete-job-dialog";

type SortKey =
  | "deployment"
  | "status"
  | "images"
  | "detections"
  | "species"
  | "date";
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
  deployment: { id: number; name: string } | null;
  detectionsCount: number;
  speciesCount: number;
  verifiedCount: number;
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
    return (
      <TableHead
        className="cursor-pointer select-none hover:bg-muted/50"
        onClick={() => toggleSort(col)}
      >
        {label} {sortKey === col ? (sortDir === "asc" ? "↑" : "↓") : ""}
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

  return (
    <>
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHeader label="Instalación" col="deployment" />
              <SortHeader label="Estado" col="status" />
              <SortHeader label="Imágenes" col="images" />
              <SortHeader label="Detecciones" col="detections" />
              <SortHeader label="Especies" col="species" />
              <TableHead>Modelos</TableHead>
              <SortHeader label="Fecha" col="date" />
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((job) => (
              <TableRow
                key={job.id}
                className="cursor-pointer"
                onClick={() => router.push(`/camera-trap/results/${job.id}`)}
              >
                <TableCell className="font-medium">
                  {job.deployment?.name || "Instalación desconocida"}
                </TableCell>
                <TableCell>
                  <StatusBadge status={job.status} type="job" />
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
    </>
  );
}
