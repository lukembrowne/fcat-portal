"use client";

import { useState, useRef } from "react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Upload, CheckCircle, AlertCircle, Loader2, FileText } from "lucide-react";
import { previewDatFile, commitDatFile } from "./actions";
import type { UploadPreview } from "./actions";
import type { ClimateResolution } from "@/db/schema";

interface LastUpload {
  filename: string;
  uploadedBy: string;
  uploadedAt: Date;
  rowsImported: number;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
}

interface ClimateUploadShellProps {
  lastUploads: Record<ClimateResolution, LastUpload | null>;
}

function ClimateUploadCard({
  title,
  description,
  expectedResolution,
  lastUpload,
}: {
  title: string;
  description: string;
  expectedResolution: ClimateResolution;
  lastUpload: LastUpload | null;
}) {
  const [status, setStatus] = useState<"idle" | "previewing" | "previewed" | "uploading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handlePreview() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setStatus("previewing");
    setMessage("");
    setPreview(null);

    const formData = new FormData();
    formData.set("file", file);

    const result = await previewDatFile(formData);
    if (!result.success) {
      setStatus("error");
      setMessage(result.error);
      return;
    }

    // Check resolution mismatch
    if (result.data.resolution !== expectedResolution) {
      setStatus("error");
      setMessage(
        `Este archivo parece ser datos ${result.data.resolution === "hourly" ? "por hora" : "cada 15 minutos"}, no ${expectedResolution === "hourly" ? "por hora" : "cada 15 minutos"}`
      );
      return;
    }

    setPreview(result.data);
    setStatus("previewed");
  }

  async function handleCommit() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setStatus("uploading");

    const formData = new FormData();
    formData.set("file", file);

    const result = await commitDatFile(formData);
    if (!result.success) {
      setStatus("error");
      setMessage(result.error);
      return;
    }

    setStatus("success");
    setMessage(
      `${result.data.rowCount.toLocaleString()} registros importados`
    );
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleReset() {
    setStatus("idle");
    setMessage("");
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>

        {lastUpload && (
          <div className="text-xs text-muted-foreground mt-2 space-y-0.5">
            <p>
              Último archivo: <span className="font-medium">{lastUpload.filename}</span>
            </p>
            <p>
              Subido por: {lastUpload.uploadedBy} —{" "}
              {new Date(lastUpload.uploadedAt).toLocaleDateString("es-EC")}
            </p>
            <p>{lastUpload.rowsImported.toLocaleString()} registros</p>
            {lastUpload.dateRangeStart && lastUpload.dateRangeEnd && (
              <p>Rango: {lastUpload.dateRangeStart} a {lastUpload.dateRangeEnd}</p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 mt-3">
          <Input
            ref={fileRef}
            type="file"
            accept=".dat"
            className="flex-1"
            onChange={() => {
              // Reset preview when file changes
              if (status === "previewed" || status === "error" || status === "success") {
                setStatus("idle");
                setMessage("");
                setPreview(null);
              }
            }}
          />
          {status !== "previewed" ? (
            <Button
              onClick={handlePreview}
              disabled={status === "previewing" || status === "uploading"}
              size="sm"
            >
              {status === "previewing" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              <span className="ml-1">Vista Previa</span>
            </Button>
          ) : (
            <div className="flex gap-1">
              <Button onClick={handleCommit} size="sm">
                <Upload className="h-4 w-4" />
                <span className="ml-1">Subir</span>
              </Button>
              <Button onClick={handleReset} size="sm" variant="outline">
                Cancelar
              </Button>
            </div>
          )}
        </div>

        {/* Preview info */}
        {preview && status === "previewed" && (
          <div className="mt-3 rounded-md bg-muted p-3 text-sm space-y-1">
            <p>
              <span className="font-medium">{preview.rowCount.toLocaleString()}</span> registros encontrados
            </p>
            {preview.dateRange && (
              <p>
                Rango: {preview.dateRange.start} a {preview.dateRange.end}
              </p>
            )}
            <p>
              Resolución: {preview.resolution === "hourly" ? "Por hora" : "Cada 15 minutos"}
            </p>
            {preview.errorCount > 0 && (
              <p className="text-amber-600">
                {preview.errorCount} fila(s) con errores (se omitirán)
              </p>
            )}
          </div>
        )}

        {/* Status message */}
        {message && (
          <div
            className={`flex items-start gap-2 mt-2 text-sm ${
              status === "success" ? "text-green-700" : "text-destructive"
            }`}
          >
            {status === "success" ? (
              <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            )}
            <span>{message}</span>
          </div>
        )}
      </CardHeader>
    </Card>
  );
}

export function ClimateUploadShell({ lastUploads }: ClimateUploadShellProps) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Cargar Datos Climáticos</h1>
        <p className="text-muted-foreground mt-1">
          Subir archivos .dat de la estación meteorológica Campbell Scientific.
          Los datos existentes se actualizan automáticamente si se re-sube un archivo.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ClimateUploadCard
          title="Datos por Hora"
          description='Archivo "Registro_*.dat" con datos horarios de la estación central (23 columnas).'
          expectedResolution="hourly"
          lastUpload={lastUploads.hourly}
        />

        <ClimateUploadCard
          title="Datos cada 15 Minutos"
          description='Archivo "Registromin15_*.dat" con datos cada 15 minutos (21 columnas).'
          expectedResolution="15min"
          lastUpload={lastUploads["15min"]}
        />
      </div>
    </div>
  );
}
