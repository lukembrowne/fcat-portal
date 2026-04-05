"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { Trash2 } from "lucide-react";
import { DeleteJobDialog } from "../delete-job-dialog";

interface Job {
  id: number;
  status: string;
  detectorModel: string | null;
  totalImages: number;
  processedImages: number;
  failedImages: number;
  createdAt: string | null;
}

interface JobHistoryProps {
  jobs: Job[];
  canEdit: boolean;
}

export function JobHistory({ jobs, canEdit }: JobHistoryProps) {
  const [deleteJobId, setDeleteJobId] = useState<number | null>(null);
  const router = useRouter();

  if (jobs.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Sin trabajos de procesamiento.
      </p>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {jobs.map((job) => (
          <div
            key={job.id}
            className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Trabajo #{job.id}</span>
                <StatusBadge status={job.status} type="job" />
              </div>
              <p className="text-xs text-muted-foreground">
                {job.processedImages} / {job.totalImages} imágenes
                {job.failedImages > 0 && ` (${job.failedImages} fallidas)`}
                {" · "}
                Modelo: {job.detectorModel ?? "—"}
              </p>
              {job.createdAt && (
                <p className="text-xs text-muted-foreground">
                  {new Date(job.createdAt).toLocaleString("es-EC")}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1">
              {job.status === "completed" && (
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/camera-trap/results/${job.id}`}>
                    Ver Resultados
                  </Link>
                </Button>
              )}
              {canEdit && job.status !== "processing" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteJobId(job.id)}
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      <DeleteJobDialog
        jobId={deleteJobId}
        onClose={() => setDeleteJobId(null)}
        onDeleted={() => {
          setDeleteJobId(null);
          router.refresh();
        }}
      />
    </>
  );
}
