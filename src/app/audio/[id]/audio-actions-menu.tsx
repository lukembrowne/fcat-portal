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
} from "lucide-react";
import { scanDeploymentAudio } from "../actions";
import { AnalyzeAudioDialog } from "../analyze-audio-dialog";

interface AudioActionsMenuProps {
  deploymentId: number;
  uploadAudioFolderId: string | null;
  isBirdnetProcessing: boolean;
  hasBirdnetDetections: boolean;
  isAcousticIndicesProcessing: boolean;
  isAudioAnalysisProcessing?: boolean;
  hasFiles: boolean;
}

export function AudioActionsMenu({
  deploymentId,
  uploadAudioFolderId,
  isBirdnetProcessing,
  hasBirdnetDetections,
  isAcousticIndicesProcessing,
  isAudioAnalysisProcessing = false,
  hasFiles,
}: AudioActionsMenuProps) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);

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
        hasExistingBirdnet={hasBirdnetDetections}
        onComplete={() => router.refresh()}
      />
    </>
  );
}
