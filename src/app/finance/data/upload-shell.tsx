"use client";

import { useState, useRef } from "react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Upload, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import {
  commitLibroMayor,
  commitBudget,
  commitCategoryLink,
  commitSueldos,
  previewLibroMayor,
} from "./actions";

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
  description: string;
  accept: string;
  lastUpload: LastUpload | null;
  onUpload: (formData: FormData) => Promise<{ success: boolean; message: string }>;
}) {
  const [status, setStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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
          <Input ref={fileRef} type="file" accept={accept} className="flex-1" />
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
          description="Exportar desde Link Systems → Contabilidad → Reportes → Libro Mayor. Archivo CSV separado por tabulaciones."
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

        <UploadCard
          title="Presupuesto Anual (Excel)"
          description='Archivo Excel con hojas "Revenue and Summary" y "Expenses Detail".'
          accept=".xlsx,.xls"
          lastUpload={lastUploads.budget}
          onUpload={async (formData) => {
            formData.set("year", String(new Date().getFullYear()));
            const result = await commitBudget(formData);
            if (!result.success) {
              return { success: false, message: result.error };
            }
            return {
              success: true,
              message: `${result.data.itemCount} categorías de presupuesto importadas`,
            };
          }}
        />

        <UploadCard
          title="Vinculación de Categorías (Excel)"
          description="Mapeo entre categorías del presupuesto y categorías del sistema contable Link."
          accept=".xlsx,.xls"
          lastUpload={lastUploads.category_map}
          onUpload={async (formData) => {
            const result = await commitCategoryLink(formData);
            if (!result.success) {
              return { success: false, message: result.error };
            }
            return {
              success: true,
              message: `${result.data.mappingCount} mapeos de categorías importados`,
            };
          }}
        />

        <UploadCard
          title="Sueldos (Excel)"
          description='Archivo Excel con hojas "Timelines" (financiamiento por persona) y "Sueldos" (costo total por persona).'
          accept=".xlsx,.xls"
          lastUpload={lastUploads.sueldos}
          onUpload={async (formData) => {
            const result = await commitSueldos(formData);
            if (!result.success) {
              return { success: false, message: result.error };
            }
            return {
              success: true,
              message: `${result.data.grantCount} grants y ${result.data.totalCount} personas importados`,
            };
          }}
        />
      </div>
    </div>
  );
}
