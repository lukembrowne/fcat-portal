"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, AudioLines, Search, FolderSync } from "lucide-react";
import { scanAllAudio, scanDeploymentAudio } from "./actions";
import type { AudioDeploymentRow, AudioStats } from "./actions";
import { formatBytes } from "@/lib/format";

type ScanState = "idle" | "scanning" | "done" | "error";

export function AudioDeploymentsShell({
  deployments,
  stats,
  isEditor,
}: {
  deployments: AudioDeploymentRow[];
  stats: AudioStats | null;
  isEditor: boolean;
}) {
  const router = useRouter();
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [scanMessage, setScanMessage] = useState("");
  const [scanningId, setScanningId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const filtered = deployments.filter(
    (d) =>
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      (d.siteName?.toLowerCase().includes(search.toLowerCase()) ?? false) ||
      (d.ctProjectName?.toLowerCase().includes(search.toLowerCase()) ?? false)
  );

  async function handleScanAll() {
    setScanState("scanning");
    setScanMessage("Escaneando archivos de audio...");
    try {
      const result = await scanAllAudio();
      if (result.success) {
        setScanMessage(
          `${result.data.scanned} escaneado(s), ${result.data.errors} con error.`
        );
        setScanState("done");
        router.refresh();
      } else {
        setScanMessage(result.error);
        setScanState("error");
      }
    } catch (err) {
      setScanMessage(
        err instanceof Error ? err.message : "Error inesperado"
      );
      setScanState("error");
    }
  }

  async function handleScanOne(deploymentId: number) {
    setScanningId(deploymentId);
    try {
      const result = await scanDeploymentAudio(deploymentId);
      if (result.success) {
        router.refresh();
      }
    } catch {
      // silent — user will see stale data
    }
    setScanningId(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <AudioLines className="h-6 w-6" />
            Grabaciones
          </h1>
          <p className="text-muted-foreground mt-1">
            Archivos de audio de grabadoras pasivas
          </p>
        </div>
        {isEditor && (
          <Button
            onClick={handleScanAll}
            disabled={scanState === "scanning"}
            variant="outline"
          >
            {scanState === "scanning" ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <FolderSync className="h-4 w-4 mr-2" />
            )}
            Escanear Todo
          </Button>
        )}
      </div>

      {scanMessage && (
        <div
          className={`text-sm px-3 py-2 rounded ${
            scanState === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {scanMessage}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">Instalaciones</div>
            <div className="text-2xl font-bold">{stats.totalDeployments}</div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">
              Archivos de Audio
            </div>
            <div className="text-2xl font-bold">{stats.totalFiles}</div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">Tamaño Total</div>
            <div className="text-2xl font-bold">
              {formatBytes(stats.totalSizeBytes)}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar instalación..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {filtered.length} instalación(es)
        </span>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Instalación</TableHead>
              <TableHead>Sitio</TableHead>
              <TableHead>Proyecto</TableHead>
              <TableHead>Fechas</TableHead>
              <TableHead className="text-right">En Drive</TableHead>
              <TableHead className="text-right">Escaneados</TableHead>
              {isEditor && <TableHead className="w-[100px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={isEditor ? 7 : 6}
                  className="h-24 text-center text-muted-foreground"
                >
                  No hay instalaciones con audio
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((dep) => (
                <TableRow key={dep.id}>
                  <TableCell>
                    <Link
                      href={`/audio/${dep.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {dep.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {dep.siteName ?? "—"}
                  </TableCell>
                  <TableCell>
                    {dep.ctProjectName ? (
                      <Badge variant="outline">{dep.ctProjectName}</Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {dep.dateStart && dep.dateEnd
                      ? `${dep.dateStart} → ${dep.dateEnd}`
                      : dep.dateStart ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {dep.uploadAudioCount ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {dep.audioFileCount > 0 ? (
                      dep.audioFileCount
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  {isEditor && (
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={scanningId === dep.id}
                        onClick={() => handleScanOne(dep.id)}
                      >
                        {scanningId === dep.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <FolderSync className="h-3 w-3" />
                        )}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
