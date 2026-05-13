"use client";

import { useState } from "react";
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
  MoreHorizontal,
  FolderSync,
  AudioWaveform,
  ExternalLink,
  Loader2,
  FileArchive,
  Undo2,
} from "lucide-react";
import { scanDeploymentAudio } from "../actions";
import { AnalyzeAudioDialog } from "../analyze-audio-dialog";
import { CompressAudioConfirmDialog } from "../compress-audio-confirm-dialog";
import { RevertAudioCompressionConfirmDialog } from "../revert-audio-compression-confirm-dialog";

interface AudioActionsMenuProps {
  deploymentId: number;
  deploymentName?: string;
  uploadAudioFolderId: string | null;
  isBirdnetProcessing: boolean;
  hasBirdnetDetections: boolean;
  isAcousticIndicesProcessing: boolean;
  isAudioAnalysisProcessing?: boolean;
  isAudioCompressionProcessing?: boolean;
  /** Admin on `grabaciones` — gates compression menu items + analyze-dialog checkbox. */
  canAdmin?: boolean;
  uncompressedFileCount?: number;
  revertibleFileCount?: number;
  hasFiles: boolean;
}

export function AudioActionsMenu({
  deploymentId,
  deploymentName,
  uploadAudioFolderId,
  isBirdnetProcessing,
  hasBirdnetDetections,
  isAcousticIndicesProcessing,
  isAudioAnalysisProcessing = false,
  isAudioCompressionProcessing = false,
  canAdmin = false,
  uncompressedFileCount = 0,
  revertibleFileCount = 0,
  hasFiles,
}: AudioActionsMenuProps) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [compressTargetId, setCompressTargetId] = useState<number | null>(null);
  const [revertTargetId, setRevertTargetId] = useState<number | null>(null);

  const analyzing =
    isBirdnetProcessing || isAcousticIndicesProcessing || isAudioAnalysisProcessing;

  async function handleScan() {
    setScanning(true);
    try {
      await scanDeploymentAudio(deploymentId);
      router.refresh();
    } catch {
      // silent
    }
    setScanning(false);
  }

  const driveFolderUrl = uploadAudioFolderId
    ? `https://drive.google.com/drive/folders/${uploadAudioFolderId}`
    : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <MoreHorizontal className="h-4 w-4 mr-1.5" />
            Acciones
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={handleScan} disabled={scanning}>
            {scanning ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <FolderSync className="h-4 w-4 mr-2" />
            )}
            <div>
              <div>Escanear archivos</div>
              <div className="text-xs text-muted-foreground font-normal">
                Sincronizar con Google Drive
              </div>
            </div>
          </DropdownMenuItem>

          {hasFiles && (
            <DropdownMenuItem
              onClick={() => setAnalyzeOpen(true)}
              disabled={analyzing}
            >
              {analyzing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <AudioWaveform className="h-4 w-4 mr-2" />
              )}
              <div>
                <div>{analyzing ? "Procesando..." : "Analizar..."}</div>
                <div className="text-xs text-muted-foreground font-normal">
                  BirdNET y/o índices acústicos
                </div>
              </div>
            </DropdownMenuItem>
          )}

          {canAdmin && uncompressedFileCount > 0 && (
            <DropdownMenuItem
              onClick={() => setCompressTargetId(deploymentId)}
              disabled={isAudioCompressionProcessing}
            >
              {isAudioCompressionProcessing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FileArchive className="h-4 w-4 mr-2" />
              )}
              <div>
                <div>Comprimir a FLAC</div>
                <div className="text-xs text-muted-foreground font-normal">
                  {uncompressedFileCount} archivos WAV pendientes
                </div>
              </div>
            </DropdownMenuItem>
          )}

          {canAdmin && revertibleFileCount > 0 && (
            <DropdownMenuItem
              onClick={() => setRevertTargetId(deploymentId)}
              disabled={isAudioCompressionProcessing}
            >
              <Undo2 className="h-4 w-4 mr-2" />
              <div>
                <div>Revertir compresión</div>
                <div className="text-xs text-muted-foreground font-normal">
                  Restaurar {revertibleFileCount} WAVs desde Drive
                </div>
              </div>
            </DropdownMenuItem>
          )}

          {driveFolderUrl && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href={driveFolderUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  <div>
                    <div>Abrir carpeta en Drive</div>
                  </div>
                </a>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AnalyzeAudioDialog
        open={analyzeOpen}
        onOpenChange={setAnalyzeOpen}
        deploymentIds={[deploymentId]}
        subjectLabel={deploymentName}
        hasExistingBirdnet={hasBirdnetDetections}
        canAdmin={canAdmin}
        uncompressedFileCount={uncompressedFileCount}
        onComplete={() => router.refresh()}
      />

      <CompressAudioConfirmDialog
        deploymentId={compressTargetId}
        onClose={() => setCompressTargetId(null)}
        onStarted={() => router.refresh()}
      />

      <RevertAudioCompressionConfirmDialog
        deploymentId={revertTargetId}
        onClose={() => setRevertTargetId(null)}
        onStarted={() => router.refresh()}
      />
    </>
  );
}
