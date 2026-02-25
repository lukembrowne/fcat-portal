"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  AudioLines,
  ArrowLeft,
  Download,
  FolderSync,
  Loader2,
  MapPin,
  Calendar,
} from "lucide-react";
import { scanDeploymentAudio } from "../actions";
import type { AudioFileRow } from "../actions";
import { formatBytes } from "@/lib/format";
import { AudioPlayer } from "./audio-player";

interface DeploymentInfo {
  id: number;
  name: string;
  siteName: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  latitude: number | null;
  longitude: number | null;
  ctProjectName: string | null;
}

export function AudioFilesShell({
  deployment,
  files,
  isEditor,
}: {
  deployment: DeploymentInfo;
  files: AudioFileRow[];
  isEditor: boolean;
}) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  async function handleScan() {
    setScanning(true);
    try {
      await scanDeploymentAudio(deployment.id);
      router.refresh();
    } catch {
      // silent
    }
    setScanning(false);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/audio">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <AudioLines className="h-6 w-6" />
            {deployment.name}
          </h1>
          <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
            {deployment.siteName && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {deployment.siteName}
              </span>
            )}
            {deployment.dateStart && (
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {deployment.dateStart}
                {deployment.dateEnd ? ` → ${deployment.dateEnd}` : ""}
              </span>
            )}
            {deployment.ctProjectName && (
              <Badge variant="outline">{deployment.ctProjectName}</Badge>
            )}
          </div>
        </div>
        {isEditor && (
          <Button
            onClick={handleScan}
            disabled={scanning}
            variant="outline"
            size="sm"
          >
            {scanning ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <FolderSync className="h-4 w-4 mr-2" />
            )}
            Escanear
          </Button>
        )}
      </div>

      {/* Active player */}
      {activeFileId && (
        <AudioPlayer
          fileId={activeFileId}
          file={files.find((f) => f.driveFileId === activeFileId) ?? null}
          onClose={() => setActiveFileId(null)}
        />
      )}

      {/* Files table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Archivo</TableHead>
              <TableHead>Formato</TableHead>
              <TableHead className="text-right">Tamaño</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead className="w-[120px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  {isEditor
                    ? 'No hay archivos escaneados. Haz clic en "Escanear" para buscar archivos en Drive.'
                    : "No hay archivos de audio."}
                </TableCell>
              </TableRow>
            ) : (
              files.map((file) => (
                <TableRow key={file.id}>
                  <TableCell className="font-mono text-sm">
                    {file.filename}
                  </TableCell>
                  <TableCell>
                    {file.playable ? (
                      <Badge variant="secondary">
                        {file.format?.toUpperCase() ?? "—"}
                      </Badge>
                    ) : (
                      <Badge variant="destructive">
                        No compatible
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {file.fileSize ? formatBytes(file.fileSize) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {file.modifiedAt
                      ? new Date(file.modifiedAt).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      {file.playable && file.driveFileId && (
                        <Button
                          size="sm"
                          variant={
                            activeFileId === file.driveFileId
                              ? "default"
                              : "ghost"
                          }
                          onClick={() =>
                            setActiveFileId(
                              activeFileId === file.driveFileId
                                ? null
                                : file.driveFileId
                            )
                          }
                        >
                          <AudioLines className="h-3 w-3" />
                        </Button>
                      )}
                      {file.driveFileId && (
                        <a
                          href={`/api/audio/stream?fileId=${encodeURIComponent(file.driveFileId)}&download=true`}
                          download
                        >
                          <Button size="sm" variant="ghost">
                            <Download className="h-3 w-3" />
                          </Button>
                        </a>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="text-sm text-muted-foreground">
        {files.length} archivo(s)
        {files.length > 0 &&
          ` — ${formatBytes(
            files.reduce((sum, f) => sum + (f.fileSize ?? 0), 0)
          )}`}
      </div>
    </div>
  );
}
