"use client";

import { CheckCircle2, XCircle, AlertTriangle, Minus, ExternalLink } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DataStatusRow } from "./actions";

interface UploadStatusTableProps {
  rows: DataStatusRow[];
}

function StatusCell({ count, error }: { count: number | null; error?: string }) {
  // Check failed
  if (error || count === null) {
    return (
      <span className="inline-flex items-center gap-1 text-amber-600" title={error ?? "No se pudo verificar"}>
        <AlertTriangle className="size-4" />
        <span className="text-xs">Error</span>
      </span>
    );
  }

  // Files present
  if (count > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-600">
        <CheckCircle2 className="size-4" />
        <span className="text-xs">{count}</span>
      </span>
    );
  }

  // Empty or missing subfolder
  return (
    <span className="inline-flex items-center gap-1 text-red-500">
      <XCircle className="size-4" />
      <span className="text-xs">0</span>
    </span>
  );
}

function NoLinkCell() {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Minus className="size-4" />
    </span>
  );
}

export function UploadStatusTable({ rows }: UploadStatusTableProps) {
  const failedCount = rows.filter((r) => r.error).length;

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Estado de Datos</h1>
        <p className="text-muted-foreground mt-1">
          Estado de carga de datos en Google Drive por despliegue recuperado.
          Ejecuta &quot;Sync ODK&quot; en Herramientas para mantener los estados actualizados.
        </p>
      </div>

      {failedCount > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-3 mb-4">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            {failedCount} despliegue{failedCount > 1 ? "s" : ""} no se pudo{failedCount > 1 ? "ieron" : ""} verificar en Google Drive.
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border p-8 text-center text-muted-foreground">
          No hay despliegues recuperados para verificar.
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Despliegue</TableHead>
                <TableHead>Sitio</TableHead>
                <TableHead className="text-center">Visita</TableHead>
                <TableHead className="text-center">Cámaras</TableHead>
                <TableHead className="text-center">Audio</TableHead>
                <TableHead className="text-center">iButton</TableHead>
                <TableHead className="w-8"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.deployment.deploymentId}>
                  <TableCell className="font-medium">
                    {row.deployment.deploymentId}
                  </TableCell>
                  <TableCell>{row.deployment.siteName || row.deployment.siteId}</TableCell>
                  <TableCell className="text-center">
                    {row.deployment.visitNumber}
                  </TableCell>
                  <TableCell className="text-center">
                    {row.uploads ? (
                      <StatusCell count={row.uploads.camarasTrampas} error={row.error} />
                    ) : row.error ? (
                      <StatusCell count={null} error={row.error} />
                    ) : (
                      <NoLinkCell />
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {row.uploads ? (
                      <StatusCell count={row.uploads.grabadoresDeAudio} error={row.error} />
                    ) : row.error ? (
                      <StatusCell count={null} error={row.error} />
                    ) : (
                      <NoLinkCell />
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {row.uploads ? (
                      <StatusCell count={row.uploads.ibutton} error={row.error} />
                    ) : row.error ? (
                      <StatusCell count={null} error={row.error} />
                    ) : (
                      <NoLinkCell />
                    )}
                  </TableCell>
                  <TableCell>
                    {row.deployment.driveFolderLink && (
                      <a
                        href={row.deployment.driveFolderLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        title="Abrir carpeta en Drive"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
