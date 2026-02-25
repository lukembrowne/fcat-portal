"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, FolderSync, ExternalLink, AudioLines } from "lucide-react";
import { scanDeploymentAudio } from "./actions";
import type { AudioDeploymentRow } from "./actions";

interface AudioExpandedRowProps {
  deployment: AudioDeploymentRow;
  isEditor: boolean;
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

export function AudioExpandedRow({
  deployment,
  isEditor,
}: AudioExpandedRowProps) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  async function handleScan() {
    setScanning(true);
    setScanMessage(null);
    try {
      const result = await scanDeploymentAudio(deployment.id);
      if (result.success) {
        setScanMessage(
          `${result.data.total} archivo(s). ${result.data.added} nuevo(s).`
        );
        router.refresh();
      } else {
        setScanMessage(result.error);
      }
    } catch {
      setScanMessage("Error inesperado");
    }
    setScanning(false);
  }

  const driveFolderUrl = deployment.uploadAudioFolderId
    ? `https://drive.google.com/drive/folders/${deployment.uploadAudioFolderId}`
    : null;

  return (
    <div
      className="p-4 bg-muted/30 border-t"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6">
        {/* Left: Metadata */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <MetaField label="Proyecto" value={deployment.ctProjectName} />
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
              label="En Drive"
              value={
                deployment.uploadAudioCount != null
                  ? deployment.uploadAudioCount.toLocaleString()
                  : null
              }
            />
            <MetaField
              label="Escaneados"
              value={
                deployment.audioFileCount > 0
                  ? deployment.audioFileCount.toLocaleString()
                  : null
              }
            />
          </div>

          {scanMessage && (
            <p className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded">
              {scanMessage}
            </p>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex flex-col gap-2 items-start md:items-end">
          <Link
            href={`/audio/${deployment.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <Button size="sm" variant="default">
              <AudioLines className="h-3.5 w-3.5 mr-1.5" />
              Ver archivos
            </Button>
          </Link>

          {isEditor && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleScan}
              disabled={scanning}
            >
              {scanning ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <FolderSync className="h-3.5 w-3.5 mr-1.5" />
              )}
              Escanear
            </Button>
          )}

          {driveFolderUrl && isEditor && (
            <a
              href={driveFolderUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              <Button size="sm" variant="ghost">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Abrir en Drive
              </Button>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
