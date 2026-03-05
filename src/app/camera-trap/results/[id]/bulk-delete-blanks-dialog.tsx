"use client";

import { useState, useCallback, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Info, Trash2 } from "lucide-react";
import {
  countDeletableImages,
  bulkDeleteBlankImages,
  checkSetupRetrievalTags,
} from "@/app/camera-trap/actions";

type Step = "select" | "confirm" | "result";

interface BulkDeleteBlanksDialogProps {
  onClose: () => void;
  jobId: number;
}

export function BulkDeleteBlanksDialog({
  onClose,
  jobId,
}: BulkDeleteBlanksDialogProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState<Step>("select");
  const [confirmedBlankChecked, setConfirmedBlankChecked] = useState(true);
  const [noDetectionsChecked, setNoDetectionsChecked] = useState(false);
  const [unverifiedDetectionsChecked, setUnverifiedDetectionsChecked] = useState(false);
  const [counts, setCounts] = useState<{
    confirmedBlankCount: number;
    noDetectionsCount: number;
    unverifiedDetectionsCount: number;
    totalCount: number;
  } | null>(null);
  const [setupTags, setSetupTags] = useState<{
    hasDeployment: boolean;
    hasRetrieval: boolean;
  } | null>(null);
  const [result, setResult] = useState<{
    deleted: number;
    failed: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch setup/retrieval tags and initial counts on mount
  useEffect(() => {
    let cancelled = false;
    checkSetupRetrievalTags(jobId).then((res) => {
      if (!cancelled && res.success) {
        setSetupTags(res.data);
      }
    });
    countDeletableImages(jobId, {
      confirmedBlank: true,
      noDetections: false,
      unverifiedDetections: false,
    }).then((res) => {
      if (!cancelled && res.success) {
        setCounts(res.data);
      }
    });
    return () => { cancelled = true; };
  }, [jobId]);

  const fetchCounts = useCallback(
    (confirmedBlank: boolean, noDetections: boolean, unverifiedDetections: boolean) => {
      if (!confirmedBlank && !noDetections && !unverifiedDetections) {
        setCounts({ confirmedBlankCount: 0, noDetectionsCount: 0, unverifiedDetectionsCount: 0, totalCount: 0 });
        return;
      }

      startTransition(async () => {
        const res = await countDeletableImages(jobId, {
          confirmedBlank,
          noDetections,
          unverifiedDetections,
        });
        if (res.success) {
          setCounts(res.data);
        }
      });
    },
    [jobId]
  );

  const handleConfirmedBlankChange = useCallback(
    (checked: boolean) => {
      setConfirmedBlankChecked(checked);
      fetchCounts(checked, noDetectionsChecked, unverifiedDetectionsChecked);
    },
    [noDetectionsChecked, unverifiedDetectionsChecked, fetchCounts]
  );

  const handleNoDetectionsChange = useCallback(
    (checked: boolean) => {
      setNoDetectionsChecked(checked);
      fetchCounts(confirmedBlankChecked, checked, unverifiedDetectionsChecked);
    },
    [confirmedBlankChecked, unverifiedDetectionsChecked, fetchCounts]
  );

  const handleUnverifiedDetectionsChange = useCallback(
    (checked: boolean) => {
      setUnverifiedDetectionsChecked(checked);
      fetchCounts(confirmedBlankChecked, noDetectionsChecked, checked);
    },
    [confirmedBlankChecked, noDetectionsChecked, fetchCounts]
  );

  const handleDelete = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const res = await bulkDeleteBlankImages(jobId, {
        confirmedBlank: confirmedBlankChecked,
        noDetections: noDetectionsChecked,
        unverifiedDetections: unverifiedDetectionsChecked,
      });
      if (res.success) {
        setResult(res.data);
        setStep("result");
        router.refresh();
        setTimeout(() => onClose(), 2000);
      } else {
        setError(res.error);
      }
    });
  }, [jobId, confirmedBlankChecked, noDetectionsChecked, unverifiedDetectionsChecked, router, onClose]);

  const totalCount = counts?.totalCount ?? 0;
  const noneSelected = !confirmedBlankChecked && !noDetectionsChecked && !unverifiedDetectionsChecked;
  const tagsReady = setupTags?.hasDeployment && setupTags?.hasRetrieval;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" onInteractOutside={(e) => { if (isPending) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-5" />
            Eliminar imágenes vacías
          </DialogTitle>
          <DialogDescription>
            {step === "select" && "Seleccione qué imágenes eliminar de todo el trabajo (ignora filtros del visor)."}
            {step === "confirm" && "Confirme la eliminación de las imágenes seleccionadas."}
            {step === "result" && "Resultado de la eliminación."}
          </DialogDescription>
        </DialogHeader>

        {step === "result" && result ? (
          <div className="py-4 text-center">
            <p className="text-sm font-medium text-green-700">
              {result.deleted} imágenes eliminadas
              {result.failed > 0 && (
                <span className="text-destructive">
                  , {result.failed} fallaron
                </span>
              )}
            </p>
          </div>
        ) : step === "confirm" ? (
          <div className="space-y-4">
            <div className="rounded-md border p-3 space-y-2">
              <p className="text-sm font-medium">
                Se eliminarán{" "}
                <span className="tabular-nums font-semibold">{totalCount}</span>{" "}
                imágenes de Google Drive
              </p>
              {totalCount > 100 && (
                <p className="text-xs text-muted-foreground">
                  Esto puede tardar varios minutos.
                </p>
              )}
            </div>

            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="size-3.5 mt-0.5 text-amber-500 shrink-0" />
              <span>
                Esta acción moverá las imágenes a la papelera de Google Drive
                (recuperables por 30 días).
              </span>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {setupTags && !tagsReady && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Debe designar las imágenes de instalación y recogida antes de eliminar.</p>
                  <p className="text-xs mt-1">
                    {!setupTags.hasDeployment && !setupTags.hasRetrieval
                      ? "Falta: instalación y recogida"
                      : !setupTags.hasDeployment
                        ? "Falta: instalación"
                        : "Falta: recogida"}
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={confirmedBlankChecked}
                      onChange={(e) => handleConfirmedBlankChange(e.target.checked)}
                      className="accent-primary"
                    />
                    <span className="text-sm">Imágenes confirmadas vacías</span>
                  </div>
                  {counts && confirmedBlankChecked && (
                    <span className="text-sm text-muted-foreground tabular-nums">
                      ({counts.confirmedBlankCount})
                    </span>
                  )}
                </label>
                <p className="text-xs text-muted-foreground ml-6 mt-1">
                  Marcadas con &quot;Vacía&quot; y sin identificaciones activas.
                </p>
              </div>

              <div>
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={noDetectionsChecked}
                      onChange={(e) => handleNoDetectionsChange(e.target.checked)}
                      className="accent-primary"
                    />
                    <span className="text-sm">Imágenes sin detecciones</span>
                  </div>
                  {counts && noDetectionsChecked && (
                    <span className="text-sm text-muted-foreground tabular-nums">
                      ({counts.noDetectionsCount})
                    </span>
                  )}
                </label>
                <p className="text-xs text-muted-foreground ml-6 mt-1">
                  El modelo no detectó nada.
                </p>
              </div>

              <div>
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={unverifiedDetectionsChecked}
                      onChange={(e) => handleUnverifiedDetectionsChange(e.target.checked)}
                      className="accent-primary"
                    />
                    <span className="text-sm">Imágenes con detecciones sin verificar</span>
                  </div>
                  {counts && unverifiedDetectionsChecked && (
                    <span className="text-sm text-muted-foreground tabular-nums">
                      ({counts.unverifiedDetectionsCount})
                    </span>
                  )}
                </label>
                <p className="text-xs text-muted-foreground ml-6 mt-1">
                  Todas las detecciones están sin verificar — posibles falsos positivos.
                  Imágenes con identificaciones verificadas o corregidas no se incluyen.
                </p>
              </div>
            </div>

            {!noneSelected && counts && (
              <div className="border-t pt-3">
                <p className="text-sm font-medium">
                  Total a eliminar:{" "}
                  <span className="tabular-nums">{totalCount}</span> imágenes
                </p>
              </div>
            )}

            <div className="space-y-2 text-xs text-muted-foreground">
              <div className="flex items-start gap-2">
                <Info className="size-3.5 mt-0.5 text-blue-500 shrink-0" />
                <span>
                  Imágenes con etiqueta de instalación/recogida serán excluidas.
                </span>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === "select" && (
            <>
              <Button
                variant="outline"
                onClick={onClose}
                disabled={isPending}
              >
                Cancelar
              </Button>
              <Button
                onClick={() => setStep("confirm")}
                disabled={isPending || noneSelected || totalCount === 0 || !tagsReady}
              >
                Siguiente
              </Button>
            </>
          )}
          {step === "confirm" && (
            <>
              <Button
                variant="outline"
                onClick={() => { setStep("select"); setError(null); }}
                disabled={isPending}
              >
                Volver
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={isPending}
              >
                {isPending
                  ? `Eliminando ${totalCount} imágenes...`
                  : "Confirmar eliminación"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
