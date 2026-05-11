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
  Bird,
  AudioWaveform,
  ExternalLink,
  Loader2,
} from "lucide-react";
import {
  scanDeploymentAudio,
  createBirdNETJob,
  createAcousticIndicesJob,
} from "../actions";

interface AudioActionsMenuProps {
  deploymentId: number;
  uploadAudioFolderId: string | null;
  isBirdnetProcessing: boolean;
  hasBirdnetDetections: boolean;
  isAcousticIndicesProcessing: boolean;
  hasFiles: boolean;
}

export function AudioActionsMenu({
  deploymentId,
  uploadAudioFolderId,
  isBirdnetProcessing,
  hasBirdnetDetections,
  isAcousticIndicesProcessing,
  hasFiles,
}: AudioActionsMenuProps) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [birdnetStarting, setBirdnetStarting] = useState(false);
  const [indicesStarting, setIndicesStarting] = useState(false);

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

  async function handleBirdNET() {
    if (hasBirdnetDetections) {
      const ok = window.confirm(
        "Se eliminarán las detecciones BirdNET previas. Las anotaciones manuales se conservarán. ¿Continuar?"
      );
      if (!ok) return;
    }

    setBirdnetStarting(true);
    try {
      const result = await createBirdNETJob(deploymentId);
      if (!result.success) {
        alert(result.error);
        setBirdnetStarting(false);
        return;
      }
      window.dispatchEvent(new Event("job-started"));
      router.refresh();
    } catch {
      setBirdnetStarting(false);
    }
  }

  async function handleAcousticIndices() {
    setIndicesStarting(true);
    try {
      const result = await createAcousticIndicesJob({ deploymentId });
      if (!result.success) {
        alert(result.error);
        setIndicesStarting(false);
        return;
      }
      window.dispatchEvent(new Event("job-started"));
      router.refresh();
    } catch {
      setIndicesStarting(false);
    }
  }

  const driveFolderUrl = uploadAudioFolderId
    ? `https://drive.google.com/drive/folders/${uploadAudioFolderId}`
    : null;

  return (
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
            onClick={handleBirdNET}
            disabled={isBirdnetProcessing || birdnetStarting}
          >
            {birdnetStarting || isBirdnetProcessing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Bird className="h-4 w-4 mr-2" />
            )}
            <div>
              <div>
                {birdnetStarting || isBirdnetProcessing
                  ? "Procesando..."
                  : "Analizar con BirdNET"}
              </div>
              <div className="text-xs text-muted-foreground font-normal">
                Identificación automática de aves
              </div>
            </div>
          </DropdownMenuItem>
        )}

        {hasFiles && (
          <DropdownMenuItem
            onClick={handleAcousticIndices}
            disabled={isAcousticIndicesProcessing || indicesStarting}
          >
            {indicesStarting || isAcousticIndicesProcessing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <AudioWaveform className="h-4 w-4 mr-2" />
            )}
            <div>
              <div>
                {indicesStarting || isAcousticIndicesProcessing
                  ? "Calculando..."
                  : "Calcular Índices Acústicos"}
              </div>
              <div className="text-xs text-muted-foreground font-normal">
                Saturación, ACI, entropías, eventos
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
  );
}
