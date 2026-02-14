"use client";

import { useState, useEffect, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import {
  ExternalLink,
  Pencil,
  Play,
  ScanSearch,
  Loader2,
  Trash2,
} from "lucide-react";
import type { DeploymentRow } from "./actions";
import { DeploymentEditForm } from "./deployment-edit-form";
import { getDeployment, queueProcessing } from "./actions";
import { DeleteJobDialog } from "./delete-job-dialog";
import { scanDeploymentImages } from "./drive-actions";

interface JobInfo {
  id: number;
  status: string;
  detectorModel: string | null;
  classifierModel: string | null;
  totalImages: number;
  processedImages: number;
  createdAt: Date;
  completedAt: Date | null;
}

interface DeploymentExpandedRowProps {
  deployment: DeploymentRow;
  canEdit: boolean;
  distinctProjects: string[];
  cachedJobs: JobInfo[] | undefined;
  onCacheJobs: (deploymentId: number, jobs: JobInfo[]) => void;
}

export function DeploymentExpandedRow({
  deployment,
  canEdit,
  distinctProjects,
  cachedJobs,
  onCacheJobs,
}: DeploymentExpandedRowProps) {
  const [editing, setEditing] = useState(false);
  const [jobs, setJobs] = useState<JobInfo[]>(cachedJobs ?? []);
  const [loadingJobs, setLoadingJobs] = useState(!cachedJobs);
  const [jobsError, setJobsError] = useState(false);
  const [scanning, startScanning] = useTransition();
  const [processingAction, startProcessing] = useTransition();
  const [deleteJobId, setDeleteJobId] = useState<number | null>(null);

  useEffect(() => {
    if (cachedJobs) return;
    let cancelled = false;
    getDeployment(deployment.id)
      .then((data) => {
        if (cancelled) return;
        if (data) {
          const mapped = data.jobs.map((j) => ({
            id: j.id,
            status: j.status,
            detectorModel: j.detectorModel,
            classifierModel: j.classifierModel,
            totalImages: j.totalImages,
            processedImages: j.processedImages,
            createdAt: j.createdAt,
            completedAt: j.completedAt,
          }));
          setJobs(mapped);
          onCacheJobs(deployment.id, mapped);
        }
        setLoadingJobs(false);
      })
      .catch(() => {
        if (cancelled) return;
        setJobsError(true);
        setLoadingJobs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deployment.id, cachedJobs, onCacheJobs]);

  const handleScan = () => {
    startScanning(async () => {
      await scanDeploymentImages(deployment.id);
    });
  };

  const handleProcess = () => {
    startProcessing(async () => {
      await queueProcessing([deployment.id]);
      window.dispatchEvent(new Event("job-started"));
    });
  };

  const handleJobDeleted = (jobId: number) => {
    const updated = jobs.filter((j) => j.id !== jobId);
    setJobs(updated);
    onCacheJobs(deployment.id, updated);
  };

  return (
    <div className="p-4 bg-muted/30 border-t">
      {editing ? (
        <div className="max-w-md">
          <DeploymentEditForm
            deployment={deployment}
            distinctProjects={distinctProjects}
            onCancel={() => setEditing(false)}
            onSaved={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-6">
          {/* Left: Metadata + Actions */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <MetaField label="Proyecto" value={deployment.projectLabel} />
              <MetaField label="Sitio" value={deployment.siteName} />
              <MetaField
                label="Latitud"
                value={deployment.latitude?.toFixed(5)}
              />
              <MetaField
                label="Longitud"
                value={deployment.longitude?.toFixed(5)}
              />
              <MetaField label="Fecha inicio" value={deployment.dateStart} />
              <MetaField label="Fecha fin" value={deployment.dateEnd} />
              <MetaField
                label="Imagenes"
                value={
                  deployment.totalImages != null && deployment.totalImages > 0
                    ? deployment.totalImages.toLocaleString()
                    : null
                }
              />
              <MetaField
                label="Fuente"
                value={
                  deployment.metadataSource === "odk"
                    ? "ODK"
                    : deployment.metadataSource === "drive"
                      ? "Drive"
                      : deployment.metadataSource === "manual"
                        ? "Manual"
                        : null
                }
              />
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {deployment.driveFolderId && (
                <a
                  href={`https://drive.google.com/drive/folders/${deployment.driveFolderId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  Abrir en Drive
                </a>
              )}
              {canEdit && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(true)}
                    className="h-7 text-xs"
                  >
                    <Pencil className="h-3 w-3 mr-1" />
                    Editar
                  </Button>
                  {(deployment.status === "unscanned" || deployment.status === "scanned") && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleScan}
                      disabled={scanning}
                      className="h-7 text-xs"
                    >
                      {scanning ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <ScanSearch className="h-3 w-3 mr-1" />
                      )}
                      Buscar imágenes
                    </Button>
                  )}
                  {deployment.status !== "processing" && (
                    <Button
                      size="sm"
                      onClick={handleProcess}
                      disabled={processingAction}
                      className="h-7 text-xs"
                    >
                      {processingAction ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3 mr-1" />
                      )}
                      Procesar
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right: Processing History */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Historial de Procesamiento
            </h4>
            {loadingJobs ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Cargando...
              </div>
            ) : jobsError ? (
              <p className="text-xs text-destructive">
                Error al cargar historial.
              </p>
            ) : jobs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Sin trabajos de procesamiento.
              </p>
            ) : (
              <div className="space-y-2">
                {jobs.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between p-2 rounded-md border bg-background text-xs"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={job.status} type="job" />
                        <span className="text-muted-foreground">
                          {new Date(job.createdAt).toLocaleDateString("es-EC", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </span>
                      </div>
                      <div className="text-muted-foreground">
                        {job.processedImages}/{job.totalImages} imagenes
                      </div>
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
            )}
          </div>
        </div>
      )}
      <DeleteJobDialog
        jobId={deleteJobId}
        onClose={() => setDeleteJobId(null)}
        onDeleted={handleJobDeleted}
      />
    </div>
  );
}

function MetaField({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="font-medium text-xs">{value ?? "—"}</p>
    </div>
  );
}
