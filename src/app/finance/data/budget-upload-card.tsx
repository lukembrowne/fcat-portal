"use client";

import { useState, useRef, useId } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Upload,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { previewBudget, commitBudget, type BudgetPreview } from "./actions";

interface LastUpload {
  fileName: string;
  uploadedBy: string;
  uploadedAt: Date;
  rowCount: number | null;
}

function formatCurrency(val: number) {
  return (
    "$" +
    val.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

type Phase = "idle" | "loading" | "review" | "done" | "error";

/**
 * Budget upload with an interactive pre-flight step. On upload the file is
 * parsed and any category not already recognized is surfaced for the uploader
 * to approve — nothing is imported without being shown, and approved categories
 * are remembered on subsequent uploads.
 */
export function BudgetUploadCard({ lastUpload }: { lastUpload: LastUpload | null }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<BudgetPreview | null>(null);
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  const year = String(new Date().getFullYear());

  function resetToIdle(name: string | null) {
    setFileName(name);
    setPhase("idle");
    setMessage("");
    setPreview(null);
    setApproved({});
  }

  async function doCommit(approvedList: string[]) {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setPhase("loading");
    const fd = new FormData();
    fd.set("file", file);
    fd.set("year", year);
    fd.set("approvedCategories", JSON.stringify(approvedList));

    const result = await commitBudget(fd);
    if (!result.success) {
      setPhase("error");
      setMessage(result.error);
      return;
    }
    setPhase("done");
    setMessage(
      `${result.data.itemCount} categorías de presupuesto importadas` +
        (result.data.newCount > 0
          ? ` (${result.data.newCount} nueva${result.data.newCount === 1 ? "" : "s"})`
          : "")
    );
    setPreview(null);
    setFileName(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleAnalyze() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setPhase("loading");
    setMessage("");

    const fd = new FormData();
    fd.set("file", file);
    fd.set("year", year);

    const result = await previewBudget(fd);
    if (!result.success) {
      setPhase("error");
      setMessage(result.error);
      return;
    }

    const p = result.data;
    const needsReview =
      p.newCategories.length > 0 ||
      p.removedCategories.length > 0 ||
      p.yearMismatch ||
      p.warnings.length > 0;

    if (!needsReview) {
      // Nothing to review — import directly.
      await doCommit([]);
      return;
    }

    setPreview(p);
    setApproved(Object.fromEntries(p.newCategories.map((c) => [c.category, true])));
    setPhase("review");
  }

  function handleConfirm() {
    const approvedList = (preview?.newCategories ?? [])
      .map((c) => c.category)
      .filter((cat) => approved[cat]);
    void doCommit(approvedList);
  }

  const busy = phase === "loading";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Presupuesto Anual (Excel)</CardTitle>
        <CardDescription>
          Archivo Excel con hojas &quot;Revenue and Summary&quot; y &quot;Expenses
          Detail&quot;. Al subir se revisan las categorías antes de importar.
        </CardDescription>

        {lastUpload && (
          <div className="text-xs text-muted-foreground mt-2 space-y-0.5">
            <p>
              Último archivo:{" "}
              <span className="font-medium">{lastUpload.fileName}</span>
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
            accept=".xlsx,.xls"
            className="sr-only"
            id={fileInputId}
            onChange={(e) => resetToIdle(e.target.files?.[0]?.name ?? null)}
          />
          <label
            htmlFor={fileInputId}
            className="flex-1 flex items-center gap-2 px-3 h-9 rounded-md border border-input border-dashed cursor-pointer hover:bg-accent/50 transition-colors text-sm"
          >
            <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={fileName ? "truncate" : "text-muted-foreground"}>
              {fileName || "Seleccionar archivo .xlsx,.xls"}
            </span>
          </label>
          {phase !== "review" && (
            <Button onClick={handleAnalyze} disabled={busy} size="sm">
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              <span className="ml-1">Analizar</span>
            </Button>
          )}
        </div>

        {/* Pre-flight review */}
        {phase === "review" && preview && (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-3">
            {/* Detected year + recognized total */}
            <p className="text-xs text-muted-foreground">
              Año detectado:{" "}
              <span className="font-medium text-foreground">
                {preview.detectedYear}
              </span>{" "}
              · Total reconocido:{" "}
              <span className="font-medium text-foreground tabular-nums">
                {formatCurrency(preview.knownTotal)}
              </span>{" "}
              ({preview.knownCount} categoría
              {preview.knownCount === 1 ? "" : "s"})
            </p>

            {/* Year mismatch */}
            {preview.yearMismatch && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  Se solicitó el año {preview.requestedYear}, pero el archivo usa
                  la columna del año {preview.detectedYear}. Verifique que sea el
                  archivo correcto.
                </span>
              </div>
            )}

            {/* Parser / reconciliation warnings */}
            {preview.warnings.length > 0 && (
              <div className="space-y-1">
                {preview.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-sm text-destructive"
                  >
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Categories that will be removed */}
            {preview.removedCategories.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {preview.removedCategories.length} categoría
                  {preview.removedCategories.length === 1 ? "" : "s"} se
                  eliminará{preview.removedCategories.length === 1 ? "" : "n"}
                </div>
                <p className="text-xs text-muted-foreground">
                  Están en el presupuesto actual pero no en este archivo, y se
                  borrarán al cargar:
                </p>
                <ul className="text-sm list-disc pl-5 max-h-40 overflow-y-auto">
                  {preview.removedCategories.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* New / unrecognized categories to approve */}
            {preview.newCategories.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                  {preview.newCategories.length} categoría
                  {preview.newCategories.length === 1 ? "" : "s"} nueva
                  {preview.newCategories.length === 1 ? "" : "s"} sin reconocer
                </div>
                <p className="text-xs text-muted-foreground">
                  Marque las categorías nuevas que desea incluir en el
                  presupuesto:
                </p>
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {preview.newCategories.map((c) => (
                    <label
                      key={c.category}
                      className="flex items-center gap-2 text-sm cursor-pointer"
                    >
                      <Checkbox
                        checked={approved[c.category] ?? false}
                        onCheckedChange={(v) =>
                          setApproved((a) => ({ ...a, [c.category]: v === true }))
                        }
                      />
                      <span className="flex-1">{c.category}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatCurrency(c.amount)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <Button onClick={handleConfirm} disabled={busy} size="sm">
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle className="h-4 w-4" />
                )}
                <span className="ml-1">Confirmar carga</span>
              </Button>
              <Button
                onClick={() => resetToIdle(fileName)}
                variant="outline"
                size="sm"
                disabled={busy}
              >
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {message && phase !== "review" && (
          <div
            className={`flex items-start gap-2 mt-2 text-sm ${
              phase === "done" ? "text-green-700" : "text-destructive"
            }`}
          >
            {phase === "done" ? (
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
