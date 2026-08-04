"use client";

import { useState, useRef, useId, type ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { commitLibroMayor, previewLibroMayor } from "./actions";
import { BudgetUploadCard } from "./budget-upload-card";
import { SueldosImportCard } from "./sueldos-import-card";

interface LastUpload {
  fileName: string;
  uploadedBy: string;
  uploadedAt: Date;
  rowCount: number | null;
}

interface UploadShellProps {
  lastUploads: Record<string, LastUpload | null>;
}

function UploadCard({
  title,
  description,
  accept,
  lastUpload,
  onUpload,
}: {
  title: string;
  description: ReactNode;
  accept: string;
  lastUpload: LastUpload | null;
  onUpload: (formData: FormData) => Promise<{ success: boolean; message: string }>;
}) {
  const [status, setStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  async function handleSubmit() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setStatus("uploading");
    setMessage("");

    const formData = new FormData();
    formData.set("file", file);

    const result = await onUpload(formData);
    setStatus(result.success ? "success" : "error");
    setMessage(result.message);

    // Reset file input
    setFileName(null);
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
              Último archivo: <span className="font-medium">{lastUpload.fileName}</span>
            </p>
            <p>
              Subido por: {lastUpload.uploadedBy} —{" "}
              {new Date(lastUpload.uploadedAt).toLocaleDateString("es-EC")}
            </p>
            {lastUpload.rowCount !== null && (
              <p>{lastUpload.rowCount.toLocaleString()} filas</p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 mt-3">
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            className="sr-only"
            id={fileInputId}
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          />
          <label
            htmlFor={fileInputId}
            className="flex-1 flex items-center gap-2 px-3 h-9 rounded-md border border-input border-dashed cursor-pointer hover:bg-accent/50 transition-colors text-sm"
          >
            <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={fileName ? "truncate" : "text-muted-foreground"}>
              {fileName || `Seleccionar archivo ${accept}`}
            </span>
          </label>
          <Button
            onClick={handleSubmit}
            disabled={status === "uploading"}
            size="sm"
          >
            {status === "uploading" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            <span className="ml-1">Subir</span>
          </Button>
        </div>

        {message && (
          <div
            className={`flex items-start gap-2 mt-2 text-sm ${
              status === "success"
                ? "text-green-700"
                : "text-destructive"
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

export function UploadShell({ lastUploads }: UploadShellProps) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Cargar Datos</h1>
        <p className="text-muted-foreground mt-1">
          Sube archivos de datos financieros. Cada carga reemplaza todos los datos
          anteriores del mismo tipo.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <UploadCard
          title="Libro Mayor (CSV)"
          description={
            <div className="space-y-2">
              <p>Cómo exportar el reporte desde Link Systems:</p>
              <ol className="list-decimal space-y-1 pl-4">
                <li>
                  Ingrese a{" "}
                  <a
                    href="https://mipymelink.site/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    mipymelink.site
                  </a>
                </li>
                <li>Control Financiamiento → Contabilidad</li>
                <li>Reportes → Libro Mayor</li>
                <li>
                  Seleccione el rango de fechas (el primer día disponible en Link
                  es el 1 de enero de 2023)
                </li>
                <li>
                  Escriba <span className="font-medium">9</span> en «Cuentas»
                  para incluir todas las transacciones
                </li>
                <li>
                  Descargue con la opción{" "}
                  <span className="font-medium">«Exportar a csv con punto»</span>{" "}
                  (usa formato 000.00 en vez de 000,00). Aunque diga CSV,
                  descarga un archivo Excel separado por tabulaciones.
                </li>
                <li>
                  Súbalo aquí directamente. Se recomienda incluir la fecha en el
                  nombre del archivo — por ejemplo{" "}
                  <span className="font-mono text-xs">
                    LibroMayor - 2024_12.csv
                  </span>
                </li>
              </ol>
            </div>
          }
          accept=".csv"
          lastUpload={lastUploads.libro_mayor}
          onUpload={async (formData) => {
            // Preview first
            const preview = await previewLibroMayor(formData);
            if (!preview.success) {
              return { success: false, message: preview.error };
            }

            const p = preview.data;
            const warnings = p.parseErrors.length > 0
              ? ` (${p.parseErrors.length} advertencias)`
              : "";

            // Now commit
            const file = formData.get("file") as File;
            const commitFormData = new FormData();
            commitFormData.set("file", file);

            const result = await commitLibroMayor(commitFormData);
            if (!result.success) {
              return { success: false, message: result.error };
            }
            return {
              success: true,
              message: `${result.data.rowCount.toLocaleString()} transacciones importadas${warnings}. Rango: ${p.dateRange?.min} a ${p.dateRange?.max}`,
            };
          }}
        />

        <BudgetUploadCard lastUpload={lastUploads.budget} />

        <SueldosImportCard lastUpload={lastUploads.sueldos} />
      </div>
    </div>
  );
}
