"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ExternalLink,
  Pencil,
  Play,
  ScanSearch,
  Loader2,
  Trash2,
  CheckCircle,
  Undo2,
  Save,
} from "lucide-react";
import type { DeploymentRow } from "./actions";
import { DeploymentEditForm } from "./deployment-edit-form";
import { getDeployment, queueProcessing, markVerifiedEmpty, undoVerifiedEmpty, updateDeploymentQa } from "./actions";
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

interface CtProject {
  id: number;
  name: string;
}

interface DeploymentExpandedRowProps {
  deployment: DeploymentRow;
  canEdit: boolean;
  distinctProjects: CtProject[];
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
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [jobs, setJobs] = useState<JobInfo[]>(cachedJobs ?? []);
  const [loadingJobs, setLoadingJobs] = useState(!cachedJobs);
  const [jobsError, setJobsError] = useState(false);
  const [scanning, startScanning] = useTransition();
  const [processingAction, startProcessing] = useTransition();
  const [verifying, startVerifying] = useTransition();
  const [deleteJobId, setDeleteJobId] = useState<number | null>(null);

  // QA inline editing state
  const [excluded, setExcluded] = useState(deployment.excluded);
  const [validStart, setValidStart] = useState(deployment.validStart ?? "");
  const [validEnd, setValidEnd] = useState(deployment.validEnd ?? "");
  const [qaNotes, setQaNotes] = useState(deployment.qaNotes ?? "");
  const [savingQa, startSavingQa] = useTransition();
  const [qaError, setQaError] = useState<string | null>(null);
  const [qaSaved, setQaSaved] = useState(false);

  const qaChanged =
    excluded !== deployment.excluded ||
    (validStart || null) !== deployment.validStart ||
    (validEnd || null) !== deployment.validEnd ||
    ((qaNotes.trim() || null) !== deployment.qaNotes);

  const qaDateWarning =
    validStart && validEnd && validStart > validEnd
      ? "La fecha de inicio válida debe ser anterior a la fecha de fin"
      : null;

  const handleSaveQa = () => {
    startSavingQa(async () => {
      setQaError(null);
      const result = await updateDeploymentQa(deployment.id, {
        excluded,
        validStart: validStart || null,
        validEnd: validEnd || null,
        qaNotes: qaNotes.trim() || null,
      });
      if (result.success) {
        setQaSaved(true);
        setTimeout(() => setQaSaved(false), 2000);
      } else {
        setQaError(result.error);
      }
    });
  };

  // Sync QA state when deployment prop changes (e.g. after revalidation)
  useEffect(() => {
    setExcluded(deployment.excluded);
    setValidStart(deployment.validStart ?? "");
    setValidEnd(deployment.validEnd ?? "");
    setQaNotes(deployment.qaNotes ?? "");
  }, [deployment.excluded, deployment.validStart, deployment.validEnd, deployment.qaNotes]);

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

  const handleVerifyEmpty = () => {
    startVerifying(async () => {
      const result = await markVerifiedEmpty(deployment.id);
      if (!result.success) {
        console.error("[markVerifiedEmpty]", result.error);
      }
      router.refresh();
    });
  };

  const handleUndoVerify = () => {
    startVerifying(async () => {
      const result = await undoVerifiedEmpty(deployment.id);
      if (!result.success) {
        console.error("[undoVerifiedEmpty]", result.error);
      }
      router.refresh();
    });
  };

  const handleJobDeleted = (jobId: number) => {
    const updated = jobs.filter((j) => j.id !== jobId);
    setJobs(updated);
    onCacheJobs(deployment.id, updated);
  };

  return (
    <div className="p-4 bg-muted/30 border-t" onClick={(e) => e.stopPropagation()}>
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
                label="Imágenes"
                value={
                  deployment.totalImages != null && deployment.totalImages > 0
                    ? deployment.totalImages.toLocaleString()
                    : null
                }
              />
              <MetaField
                label="Videos"
                value={
                  deployment.totalVideos != null && deployment.totalVideos > 0
                    ? deployment.totalVideos.toLocaleString()
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

            {/* QA Section */}
            <div className="border-t pt-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Control de Calidad</p>
              {canEdit ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`qa-excluded-${deployment.id}`}
                      checked={excluded}
                      onCheckedChange={(v) => setExcluded(!!v)}
                    />
                    <Label htmlFor={`qa-excluded-${deployment.id}`} className="text-xs font-normal">
                      Excluir de exportaciones
                    </Label>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label htmlFor={`qa-valid-start-${deployment.id}`} className="text-[10px] text-muted-foreground">
                        Inicio válido
                      </Label>
                      <Input
                        id={`qa-valid-start-${deployment.id}`}
                        type="datetime-local"
                        className="h-7 text-xs"
                        value={validStart}
                        onChange={(e) => setValidStart(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`qa-valid-end-${deployment.id}`} className="text-[10px] text-muted-foreground">
                        Fin válido
                      </Label>
                      <Input
                        id={`qa-valid-end-${deployment.id}`}
                        type="datetime-local"
                        className="h-7 text-xs"
                        value={validEnd}
                        onChange={(e) => setValidEnd(e.target.value)}
                      />
                    </div>
                  </div>
                  {qaDateWarning && (
                    <p className="text-xs text-amber-600">{qaDateWarning}</p>
                  )}

                  <div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`qa-notes-${deployment.id}`} className="text-[10px] text-muted-foreground">
                        Notas de calidad
                      </Label>
                      <span className={`text-[10px] ${qaNotes.length > 2000 ? "text-destructive" : "text-muted-foreground"}`}>
                        {qaNotes.length} / 2000
                      </span>
                    </div>
                    <Textarea
                      id={`qa-notes-${deployment.id}`}
                      value={qaNotes}
                      onChange={(e) => setQaNotes(e.target.value)}
                      placeholder="Problemas con la cámara, datos, etc."
                      rows={2}
                      maxLength={2000}
                      className="text-xs"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    {qaChanged && (
                      <Button
                        size="sm"
                        onClick={handleSaveQa}
                        disabled={savingQa || !!qaDateWarning}
                        className="h-7 text-xs"
                      >
                        {savingQa ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <Save className="h-3 w-3 mr-1" />
                        )}
                        Guardar QA
                      </Button>
                    )}
                    {qaSaved && (
                      <span className="text-xs text-green-600">Guardado</span>
                    )}
                    {qaError && (
                      <span className="text-xs text-destructive">{qaError}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  {deployment.excluded && (
                    <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5">
                      <div className="h-2 w-2 rounded-full bg-destructive shrink-0" />
                      <p className="text-xs font-medium text-destructive">Excluida de exportaciones</p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <MetaField label="Inicio válido" value={deployment.validStart} />
                    <MetaField label="Fin válido" value={deployment.validEnd} />
                  </div>
                  {deployment.qaNotes && (
                    <div className="rounded-md border bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
                      <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide mb-0.5">Notas QA</p>
                      <p className="text-xs whitespace-pre-wrap">{deployment.qaNotes}</p>
                    </div>
                  )}
                </div>
              )}
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
                  {deployment.status === "processed" && (deployment.totalDetections ?? 0) === 0 && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleVerifyEmpty}
                            disabled={verifying}
                            className="h-7 text-xs"
                          >
                            {verifying ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <CheckCircle className="h-3 w-3 mr-1" />
                            )}
                            Verificar vacío
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          Confirma que esta instalación no tiene detecciones de fauna. Úsalo después de revisar las fotos y verificar que realmente no hay animales.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {deployment.status === "verified_empty" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleUndoVerify}
                      disabled={verifying}
                      className="h-7 text-xs"
                    >
                      {verifying ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Undo2 className="h-3 w-3 mr-1" />
                      )}
                      Deshacer verificación
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
