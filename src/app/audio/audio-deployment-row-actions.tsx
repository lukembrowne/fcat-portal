"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
  ExternalLink,
  AudioLines,
  Loader2,
} from "lucide-react";
import { scanDeploymentAudio, createBirdNETJob } from "./actions";
import type { AudioDeploymentRow } from "./actions";

interface AudioDeploymentRowActionsProps {
  deployment: AudioDeploymentRow;
  canEdit: boolean;
}

export function AudioDeploymentRowActions({
  deployment,
  canEdit,
}: AudioDeploymentRowActionsProps) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [birdnetStarting, setBirdnetStarting] = useState(false);

  async function handleScan(e: React.MouseEvent) {
    e.stopPropagation();
    setScanning(true);
    try {
      await scanDeploymentAudio(deployment.id);
      router.refresh();
    } catch {
      // silent
    }
    setScanning(false);
  }

  async function handleBirdNET(e: React.MouseEvent) {
    e.stopPropagation();
    if (deployment.totalDetections > 0) {
      const ok = window.confirm(
        "Se eliminarán las detecciones BirdNET previas. Las anotaciones manuales se conservarán. ¿Continuar?"
      );
      if (!ok) return;
    }

    setBirdnetStarting(true);
    try {
      const result = await createBirdNETJob(deployment.id);
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

  const driveFolderUrl = deployment.uploadAudioFolderId
    ? `https://drive.google.com/drive/folders/${deployment.uploadAudioFolderId}`
    : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenuItem asChild>
          <Link href={`/audio/${deployment.id}`}>
            <AudioLines className="h-4 w-4 mr-2" />
            Ver archivos
          </Link>
        </DropdownMenuItem>

        {canEdit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleScan} disabled={scanning}>
              {scanning ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FolderSync className="h-4 w-4 mr-2" />
              )}
              Escanear archivos
            </DropdownMenuItem>

            {deployment.audioFileCount > 0 && (
              <DropdownMenuItem
                onClick={handleBirdNET}
                disabled={deployment.isBirdnetProcessing || birdnetStarting}
              >
                {birdnetStarting || deployment.isBirdnetProcessing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Bird className="h-4 w-4 mr-2" />
                )}
                {deployment.isBirdnetProcessing
                  ? "Procesando..."
                  : "Analizar con BirdNET"}
              </DropdownMenuItem>
            )}
          </>
        )}

        {driveFolderUrl && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={driveFolderUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-2" />
                Abrir en Drive
              </a>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
