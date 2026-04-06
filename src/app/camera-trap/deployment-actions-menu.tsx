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
  Archive,
  Undo2,
  CheckCircle,
  Images,
  Trash2,
  ScanSearch,
  Link2,
  MoreHorizontal,
  RefreshCw,
  ExternalLink,
  Eye,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import {
  markVerifiedEmpty,
  undoVerifiedEmpty,
  markVerified,
  undoVerified,
  getUnverifiedCount,
} from "./actions";
import { scanDeploymentImages } from "./drive-actions";
import { matchOdkDeployments } from "./odk-actions";
import { CompressConfirmDialog } from "./compress-confirm-dialog";
import { RevertConfirmDialog } from "./revert-confirm-dialog";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { ProcessConfirmDialog } from "./process-confirm-dialog";
import { BulkDeleteBlanksDialog } from "./results/[id]/bulk-delete-blanks-dialog";

/**
 * Shared "Acciones" dropdown menu used by both the deployments table row
 * and the deployment detail page header. Identical visual + functional UI
 * across both contexts so users see the same actions everywhere.
 */
export interface DeploymentActionsMenuProps {
  deploymentId: number;
  deploymentName: string;
  status: string;
  totalDetections: number;
  totalImages: number;
  hasImages: boolean;
  hasResults: boolean;
  driveFolderId: string | null;
  /** ID of the most recent completed job, used for "Ver Resultados" and "Eliminar vacías". */
  lastCompletedJobId: number | null;
  /** How many compressed images can be reverted. Used to gate the "Comprimir" / "Deshacer Compresión" items. */
  revertibleImageCount: number;
  canEdit: boolean;
  isAdmin: boolean;
  /** Show "Ver Detalles" navigation link. True for the row variant, false on the detail page itself. */
  showDetailsLink?: boolean;
  /** Compact icon-only trigger for dense table rows. Defaults to false (labeled "Acciones" button). */
  compact?: boolean;
  /** Override what happens after delete. Defaults to `router.refresh()`. */
  onDeleted?: () => void;
}

export function DeploymentActionsMenu({
  deploymentId,
  deploymentName,
  status,
  totalDetections,
  totalImages,
  hasImages,
  hasResults,
  driveFolderId,
  lastCompletedJobId,
  revertibleImageCount,
  canEdit,
  isAdmin,
  showDetailsLink = false,
  compact = false,
  onDeleted,
}: DeploymentActionsMenuProps) {
  const router = useRouter();
  const [scanningAction, startScanning] = useTransition();
  const [verifyingAction, startVerifying] = useTransition();
  const [odkAction, startOdk] = useTransition();
  const [compressDialogId, setCompressDialogId] = useState<number | null>(null);
  const [revertDialogId, setRevertDialogId] = useState<number | null>(null);
  const [deleteDialogId, setDeleteDialogId] = useState<number | null>(null);
  const [processDialogIds, setProcessDialogIds] = useState<number[] | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const isProcessing = status === "processing";
  const anyPending = scanningAction || verifyingAction || odkAction;

  const handleScan = () => {
    startScanning(async () => {
      const result = await scanDeploymentImages(deploymentId);
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
      const result = await matchOdkDeployments([deploymentId]);
      if (result.success) {
        const { matched } = result.data;
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
      const result = await markVerifiedEmpty(deploymentId);
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
      const result = await undoVerifiedEmpty(deploymentId);
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
      const countResult = await getUnverifiedCount(deploymentId);
      const unverified = countResult.success ? countResult.data.unverified : 0;

      if (unverified > 0) {
        const confirmed = window.confirm(
          `Hay ${unverified} identificaciones sin revisar. ¿Marcar como verificada de todos modos?`
        );
        if (!confirmed) return;
      }

      const result = await markVerified(deploymentId);
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
      const result = await undoVerified(deploymentId);
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

  const handleDeleteSuccess = () => {
    if (onDeleted) onDeleted();
    else router.refresh();
  };

  if (!canEdit) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {compact ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Acciones"
              title="Acciones"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          ) : (
            <Button variant="outline" size="sm">
              <MoreHorizontal className="h-4 w-4 mr-1.5" />
              Acciones
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {/* Reprocess (only when results exist) */}
          {hasResults && !isProcessing && (
            <>
              <DropdownMenuItem onClick={() => setProcessDialogIds([deploymentId])}>
                <RefreshCw className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>Reprocesar</div>
                  <p className="text-xs text-amber-600 font-normal">
                    Ejecutar ML de nuevo. Las verificaciones existentes se perderán.
                  </p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}

          {/* Initial process (when no results yet) */}
          {!hasResults && !isProcessing && hasImages && (
            <>
              <DropdownMenuItem onClick={() => setProcessDialogIds([deploymentId])}>
                <RefreshCw className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>Procesar Imágenes</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Ejecutar ML para detectar y clasificar especies
                  </p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}

          {/* Scan & ODK */}
          {!isProcessing && (
            <DropdownMenuItem
              onClick={handleScan}
              disabled={scanningAction || anyPending}
            >
              <ScanSearch className="h-4 w-4 mr-2 shrink-0" />
              <div>
                <div>{scanningAction ? "Escaneando..." : "Buscar Imágenes"}</div>
                <p className="text-xs text-muted-foreground font-normal">
                  Escanear la carpeta de Drive para encontrar nuevas imágenes
                </p>
              </div>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={handleOdkMatch}
            disabled={odkAction || anyPending}
          >
            <Link2 className="h-4 w-4 mr-2 shrink-0" />
            <div>
              <div>{odkAction ? "Vinculando..." : "Vincular ODK"}</div>
              <p className="text-xs text-muted-foreground font-normal">
                Buscar datos de instalación en ODK Central
              </p>
            </div>
          </DropdownMenuItem>

          {/* Verify empty */}
          {status === "processed" && totalDetections === 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleVerifyEmpty}
                disabled={verifyingAction || anyPending}
              >
                <CheckCircle className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>{verifyingAction ? "Verificando..." : "Verificar Vacío"}</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Confirmar que no hay detecciones en esta instalación
                  </p>
                </div>
              </DropdownMenuItem>
            </>
          )}
          {status === "processed" && totalDetections > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleMarkVerified}
                disabled={verifyingAction || anyPending}
              >
                <CheckCircle className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>{verifyingAction ? "Verificando..." : "Marcar como Verificada"}</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Confirmar que la revisión de esta instalación está completa
                  </p>
                </div>
              </DropdownMenuItem>
            </>
          )}
          {status === "verified_empty" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleUndoVerify}
                disabled={verifyingAction || anyPending}
              >
                <Undo2 className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>{verifyingAction ? "Deshaciendo..." : "Deshacer Verificación"}</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Revertir el estado de vacía verificada
                  </p>
                </div>
              </DropdownMenuItem>
            </>
          )}
          {status === "verified" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleUndoVerified}
                disabled={verifyingAction || anyPending}
              >
                <Undo2 className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>{verifyingAction ? "Reabriendo..." : "Re-abrir Revisión"}</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Volver al estado de procesada para continuar la revisión
                  </p>
                </div>
              </DropdownMenuItem>
            </>
          )}

          {/* Navigation */}
          <DropdownMenuSeparator />
          {showDetailsLink && (
            <DropdownMenuItem asChild>
              <Link href={`/camera-trap/${deploymentId}`}>
                <Pencil className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>Ver Detalles</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Abrir la página detallada de esta instalación
                  </p>
                </div>
              </Link>
            </DropdownMenuItem>
          )}
          {driveFolderId && (
            <DropdownMenuItem asChild>
              <a
                href={`https://drive.google.com/drive/folders/${driveFolderId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>Abrir en Drive</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Ver la carpeta de imágenes en Google Drive
                  </p>
                </div>
              </a>
            </DropdownMenuItem>
          )}
          {hasImages && (
            <DropdownMenuItem asChild>
              <Link href={`/camera-trap/${deploymentId}/preview`}>
                <Images className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>Ver Preview</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Vista rápida de las imágenes sin procesar
                  </p>
                </div>
              </Link>
            </DropdownMenuItem>
          )}
          {hasResults && lastCompletedJobId && (
            <DropdownMenuItem asChild>
              <Link href={`/camera-trap/results/${lastCompletedJobId}`}>
                <Eye className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>Ver Resultados</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Abrir la galería del último trabajo completado
                  </p>
                </div>
              </Link>
            </DropdownMenuItem>
          )}

          {/* Compression (admin) */}
          {isAdmin && hasImages && !isProcessing && revertibleImageCount < totalImages && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setCompressDialogId(deploymentId)}>
                <Archive className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>Comprimir Imágenes</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Reducir el tamaño de las imágenes (calidad 85%)
                  </p>
                </div>
              </DropdownMenuItem>
              {revertibleImageCount > 0 && (
                <DropdownMenuItem onClick={() => setRevertDialogId(deploymentId)}>
                  <Undo2 className="h-4 w-4 mr-2 shrink-0" />
                  <div>
                    <div>Deshacer Compresión</div>
                    <p className="text-xs text-muted-foreground font-normal">
                      Restaurar las imágenes a su tamaño original
                    </p>
                  </div>
                </DropdownMenuItem>
              )}
            </>
          )}

          {/* Bulk delete blanks (admin) */}
          {isAdmin && hasResults && lastCompletedJobId && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setBulkDeleteOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>Eliminar vacías</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Eliminar imágenes vacías o sin detecciones verificadas
                  </p>
                </div>
              </DropdownMenuItem>
            </>
          )}

          {/* Delete */}
          {!isProcessing && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setDeleteDialogId(deploymentId)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2 shrink-0" />
                <div>
                  <div>Eliminar Instalación</div>
                  <p className="text-xs text-muted-foreground font-normal">
                    Eliminar esta instalación y todos sus datos permanentemente
                  </p>
                </div>
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
        deploymentName={deploymentName}
        onClose={() => setDeleteDialogId(null)}
        onDeleted={handleDeleteSuccess}
      />
      {bulkDeleteOpen && lastCompletedJobId && (
        <BulkDeleteBlanksDialog
          jobId={lastCompletedJobId}
          onClose={() => setBulkDeleteOpen(false)}
        />
      )}
    </>
  );
}
