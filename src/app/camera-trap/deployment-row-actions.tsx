"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Play,
  Loader2,
  Eye,
  MoreHorizontal,
  ScanSearch,
  Link2,
  Pencil,
  Archive,
  Undo2,
  CheckCircle,
  ExternalLink,
  Images,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { DeploymentRow } from "./actions";
import { markVerifiedEmpty, undoVerifiedEmpty, markVerified, undoVerified, getUnverifiedCount } from "./actions";
import { scanDeploymentImages } from "./drive-actions";
import { matchOdkDeployments } from "./odk-actions";
import { CompressConfirmDialog } from "./compress-confirm-dialog";
import { RevertConfirmDialog } from "./revert-confirm-dialog";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { ProcessConfirmDialog } from "./process-confirm-dialog";

interface DeploymentRowActionsProps {
  deployment: DeploymentRow;
  canEdit: boolean;
  isAdmin: boolean;
}

export function DeploymentRowActions({
  deployment,
  canEdit,
  isAdmin,
}: DeploymentRowActionsProps) {
  const router = useRouter();
  const [scanningAction, startScanning] = useTransition();
  const [verifyingAction, startVerifying] = useTransition();
  const [odkAction, startOdk] = useTransition();
  const [processDialogIds, setProcessDialogIds] = useState<number[] | null>(null);
  const [compressDialogId, setCompressDialogId] = useState<number | null>(null);
  const [revertDialogId, setRevertDialogId] = useState<number | null>(null);
  const [deleteDialogId, setDeleteDialogId] = useState<number | null>(null);

  const isProcessing = deployment.status === "processing";
  const hasImages = (deployment.totalImages ?? 0) > 0;
  const hasResults = !!deployment.lastCompletedJobId;

  const handleScan = () => {
    startScanning(async () => {
      const result = await scanDeploymentImages(deployment.id);
      if (result.success) {
        toast.success(`Escaneo completado: ${result.data.imageCount} imágenes encontradas`);
        router.refresh();
      } else {
        toast.error(`Error al escanear: ${result.error}`);
      }
    });
  };

  const handleOdkMatch = () => {
    startOdk(async () => {
      const result = await matchOdkDeployments([deployment.id]);
      if (result.success) {
        const { matched, unmatched } = result.data;
        if (matched.length > 0) {
          const m = matched[0];
          toast.success(
            `Vinculado con ODK: ${m.siteName ?? "sin sitio"}${m.dateStart ? `, ${m.dateStart}` : ""}`
          );
        } else {
          toast.info("No se encontró coincidencia en ODK");
        }
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleVerifyEmpty = () => {
    startVerifying(async () => {
      const result = await markVerifiedEmpty(deployment.id);
      if (result.success) {
        toast.success("Marcada como vacía verificada");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleUndoVerify = () => {
    startVerifying(async () => {
      const result = await undoVerifiedEmpty(deployment.id);
      if (result.success) {
        toast.success("Verificación deshecha");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleMarkVerified = () => {
    startVerifying(async () => {
      const countResult = await getUnverifiedCount(deployment.id);
      const unverified = countResult.success ? countResult.data.unverified : 0;

      if (unverified > 0) {
        const confirmed = window.confirm(
          `Hay ${unverified} identificaciones sin revisar. ¿Marcar como verificada de todos modos?`
        );
        if (!confirmed) return;
      }

      const result = await markVerified(deployment.id);
      if (result.success) {
        toast.success("Instalación marcada como verificada");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleUndoVerified = () => {
    startVerifying(async () => {
      const result = await undoVerified(deployment.id);
      if (result.success) {
        toast.success("Revisión reabierta");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleJobStarted = () => {
    window.dispatchEvent(new Event("job-started"));
    router.refresh();
  };

  const handleDeleted = () => {
    router.refresh();
  };

  const anyPending = scanningAction || verifyingAction || odkAction;

  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {/* Primary action button */}
      {isProcessing ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Procesando...
        </span>
      ) : hasResults ? (
        <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
          <Link href={`/camera-trap/results/${deployment.lastCompletedJobId}`}>
            <Eye className="h-3.5 w-3.5 mr-1" />
            Resultados
          </Link>
        </Button>
      ) : canEdit ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-green-600 hover:text-green-800 hover:bg-green-50"
          onClick={() => setProcessDialogIds([deployment.id])}
        >
          <Play className="h-3.5 w-3.5 mr-1" />
          Procesar
        </Button>
      ) : null}

      {/* Overflow menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Acciones</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {/* Processing group */}
          {canEdit && !isProcessing && (
            <DropdownMenuItem
              onClick={handleScan}
              disabled={scanningAction || anyPending}
            >
              <ScanSearch className="h-4 w-4 mr-2" />
              {scanningAction ? "Escaneando..." : "Buscar Imágenes"}
            </DropdownMenuItem>
          )}
          {canEdit && (
            <DropdownMenuItem
              onClick={handleOdkMatch}
              disabled={odkAction || anyPending}
            >
              <Link2 className="h-4 w-4 mr-2" />
              {odkAction ? "Vinculando..." : "Vincular ODK"}
            </DropdownMenuItem>
          )}
          {canEdit && (
            <DropdownMenuItem asChild>
              <Link href={`/camera-trap/${deployment.id}`}>
                <Pencil className="h-4 w-4 mr-2" />
                Ver Detalles
              </Link>
            </DropdownMenuItem>
          )}

          {/* Compression group (admin only) */}
          {isAdmin && hasImages && !isProcessing && deployment.revertibleImageCount < (deployment.totalImages ?? 0) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setCompressDialogId(deployment.id)}>
                <Archive className="h-4 w-4 mr-2" />
                Comprimir Imágenes
              </DropdownMenuItem>
              {(deployment.revertibleImageCount ?? 0) > 0 && (
                <DropdownMenuItem onClick={() => setRevertDialogId(deployment.id)}>
                  <Undo2 className="h-4 w-4 mr-2" />
                  Deshacer Compresión
                </DropdownMenuItem>
              )}
            </>
          )}

          {/* Verification group */}
          {canEdit && deployment.status === "processed" && (deployment.totalDetections ?? 0) === 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleVerifyEmpty}
                disabled={verifyingAction || anyPending}
              >
                <CheckCircle className="h-4 w-4 mr-2" />
                {verifyingAction ? "Verificando..." : "Verificar Vacío"}
              </DropdownMenuItem>
            </>
          )}
          {canEdit && deployment.status === "processed" && (deployment.totalDetections ?? 0) > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleMarkVerified}
                disabled={verifyingAction || anyPending}
              >
                <CheckCircle className="h-4 w-4 mr-2" />
                {verifyingAction ? "Verificando..." : "Marcar como Verificada"}
              </DropdownMenuItem>
            </>
          )}
          {canEdit && deployment.status === "verified_empty" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleUndoVerify}
                disabled={verifyingAction || anyPending}
              >
                <Undo2 className="h-4 w-4 mr-2" />
                {verifyingAction ? "Deshaciendo..." : "Deshacer Verificación"}
              </DropdownMenuItem>
            </>
          )}
          {canEdit && deployment.status === "verified" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleUndoVerified}
                disabled={verifyingAction || anyPending}
              >
                <Undo2 className="h-4 w-4 mr-2" />
                {verifyingAction ? "Reabriendo..." : "Re-abrir Revisión"}
              </DropdownMenuItem>
            </>
          )}

          {/* Navigation group */}
          <DropdownMenuSeparator />
          {deployment.driveFolderId && (
            <DropdownMenuItem asChild>
              <a
                href={`https://drive.google.com/drive/folders/${deployment.driveFolderId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Abrir en Drive
              </a>
            </DropdownMenuItem>
          )}
          {hasImages && (
            <DropdownMenuItem asChild>
              <Link href={`/camera-trap/${deployment.id}/preview`}>
                <Images className="h-4 w-4 mr-2" />
                Ver Preview
              </Link>
            </DropdownMenuItem>
          )}
          {hasResults && (
            <DropdownMenuItem asChild>
              <Link href={`/camera-trap/results/${deployment.lastCompletedJobId}`}>
                <Eye className="h-4 w-4 mr-2" />
                Ver Resultados
              </Link>
            </DropdownMenuItem>
          )}

          {/* Destructive group */}
          {canEdit && !isProcessing && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setDeleteDialogId(deployment.id)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Eliminar
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Dialogs */}
      <ProcessConfirmDialog
        deploymentIds={processDialogIds}
        isAdmin={isAdmin}
        onClose={() => setProcessDialogIds(null)}
        onStarted={handleJobStarted}
      />
      <CompressConfirmDialog
        deploymentId={compressDialogId}
        onClose={() => setCompressDialogId(null)}
        onStarted={handleJobStarted}
      />
      <RevertConfirmDialog
        deploymentId={revertDialogId}
        onClose={() => setRevertDialogId(null)}
        onStarted={handleJobStarted}
      />
      <DeleteConfirmDialog
        deploymentId={deleteDialogId}
        deploymentName={deployment.name}
        onClose={() => setDeleteDialogId(null)}
        onDeleted={handleDeleted}
      />
    </div>
  );
}
