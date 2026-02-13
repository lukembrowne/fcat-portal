"use client";

import { useState, useEffect, useTransition, useRef } from "react";
import Link from "next/link";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { ExternalLink, Pencil, Play, ScanSearch, Loader2 } from "lucide-react";
import type { DeploymentRow } from "./actions";
import { DeploymentEditForm } from "./deployment-edit-form";
import { getDeployment, queueProcessing } from "./actions";
import { scanDeploymentImages } from "./drive-actions";

interface DeploymentPanelProps {
  deployment: DeploymentRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  distinctProjects: string[];
}

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

export function DeploymentPanel({
  deployment,
  open,
  onOpenChange,
  canEdit,
  distinctProjects,
}: DeploymentPanelProps) {
  const [editing, setEditing] = useState(false);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [scanning, startScanning] = useTransition();
  const [processingAction, startProcessing] = useTransition();
  const prevKeyRef = useRef<string | null>(null);

  // Reset state when deployment changes or panel opens
  const deploymentId = deployment?.id ?? null;
  const key = deploymentId && open ? `${deploymentId}-${open}` : null;
  if (key !== prevKeyRef.current) {
    prevKeyRef.current = key;
    setEditing(false);
    if (key) setLoadingJobs(true);
  }

  // Load jobs when deployment changes
  useEffect(() => {
    if (!deploymentId || !open) return;
    let cancelled = false;
    getDeployment(deploymentId).then((data) => {
      if (cancelled) return;
      if (data) {
        setJobs(
          data.jobs.map((j) => ({
            id: j.id,
            status: j.status,
            detectorModel: j.detectorModel,
            classifierModel: j.classifierModel,
            totalImages: j.totalImages,
            processedImages: j.processedImages,
            createdAt: j.createdAt,
            completedAt: j.completedAt,
          }))
        );
      }
      setLoadingJobs(false);
    });
    return () => { cancelled = true; };
  }, [deploymentId, open]);

  if (!deployment) return null;

  const handleScan = () => {
    startScanning(async () => {
      await scanDeploymentImages(deployment.id);
    });
  };

  const handleProcess = () => {
    startProcessing(async () => {
      await queueProcessing([deployment.id]);
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-lg overflow-y-auto"
      >
        <SheetHeader>
          <div className="flex items-center gap-2">
            <SheetTitle className="text-lg">{deployment.name}</SheetTitle>
            <StatusBadge status={deployment.status} type="deployment" />
          </div>
          <SheetDescription>
            {deployment.ctProject && `Proyecto: ${deployment.ctProject}`}
            {deployment.ctProject && deployment.siteName && " · "}
            {deployment.siteName && `Sitio: ${deployment.siteName}`}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 p-4 pt-0">
          {/* Edit form or metadata display */}
          {editing ? (
            <DeploymentEditForm
              deployment={deployment}
              distinctProjects={distinctProjects}
              onCancel={() => setEditing(false)}
              onSaved={() => setEditing(false)}
            />
          ) : (
            <>
              {/* Metadata grid */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <MetaField label="Proyecto" value={deployment.ctProject} />
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
                  label="Imágenes"
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

              {/* Drive link */}
              {deployment.driveFolderId && (
                <a
                  href={`https://drive.google.com/drive/folders/${deployment.driveFolderId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Abrir en Drive
                </a>
              )}

              {/* Action buttons */}
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(true)}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1.5" />
                    Editar
                  </Button>
                  {deployment.status === "unscanned" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleScan}
                      disabled={scanning}
                    >
                      {scanning ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <ScanSearch className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Escanear
                    </Button>
                  )}
                  {deployment.status !== "processing" && (
                    <Button
                      size="sm"
                      onClick={handleProcess}
                      disabled={processingAction}
                    >
                      {processingAction ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Procesar
                    </Button>
                  )}
                </div>
              )}
            </>
          )}

          {/* Processing history */}
          <div>
            <h3 className="text-sm font-semibold mb-2">
              Historial de Procesamiento
            </h3>
            {loadingJobs ? (
              <p className="text-sm text-muted-foreground">Cargando...</p>
            ) : jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin trabajos de procesamiento.
              </p>
            ) : (
              <div className="space-y-2">
                {jobs.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between p-2 rounded-md border text-xs"
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
                        {job.processedImages}/{job.totalImages} imágenes
                      </div>
                    </div>
                    {job.status === "completed" && (
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/camera-trap/results/${job.id}`}>
                          Ver Resultados →
                        </Link>
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
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
      <p className="font-medium">{value ?? "—"}</p>
    </div>
  );
}
