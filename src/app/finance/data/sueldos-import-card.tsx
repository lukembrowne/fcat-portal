"use client";

/**
 * Sueldos import — preview, resolve, commit.
 *
 * This replaces the old replace-all upload. It upserts, so it is safe to run
 * against a page whose salaries have been edited by hand; the one place it can
 * overwrite (a salary for the imported year) is listed explicitly before the
 * commit so it is a consented change rather than a silent one.
 *
 * Names the parser could not match to a person or group must be mapped here.
 * The commit refuses while any remain — the old importer dropped them silently,
 * which is how "Luzia Mendez" lost her Franklinia II funding.
 */

import { useRef, useState, useTransition, useId } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  Loader2,
  ArrowRight,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/finance/sueldos-fields";
import { previewSueldosImport, commitSueldosImport, type SueldosImportPreview } from "./actions";

interface LastUpload {
  fileName: string;
  uploadedBy: string;
  uploadedAt: Date;
  rowCount: number | null;
}

export function SueldosImportCard({ lastUpload }: { lastUpload: LastUpload | null }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  const [pending, startTransition] = useTransition();
  const [fileName, setFileName] = useState<string | null>(null);
  const [year, setYear] = useState<string>("");
  const [preview, setPreview] = useState<SueldosImportPreview | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function reset() {
    setPreview(null);
    setResolutions({});
    setError(null);
  }

  function runPreview() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    setDone(null);

    startTransition(async () => {
      const fd = new FormData();
      fd.set("file", file);
      if (year) fd.set("year", year);

      const res = await previewSueldosImport(fd);
      if (res.success) {
        setPreview(res.data);
        setResolutions({});
        if (!year) setYear(String(res.data.requestedYear));
      } else {
        setError(res.error);
        setPreview(null);
      }
    });
  }

  function runCommit() {
    const file = fileRef.current?.files?.[0];
    if (!file || !preview) return;
    setError(null);

    startTransition(async () => {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("year", String(preview.requestedYear));
      fd.set("resolutions", JSON.stringify(resolutions));

      const res = await commitSueldosImport(fd);
      if (res.success) {
        const d = res.data;
        setDone(
          `${d.peopleCreated} persona(s) nueva(s), ${d.salariesWritten} sueldo(s) de ${preview.requestedYear}, ${d.sourcesCreated} fuente(s) nueva(s), ${d.allocationsCreated} línea(s) de financiamiento.`
        );
        reset();
        setFileName(null);
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  const unresolvedRemaining =
    preview?.unresolvedTargets.filter((t) => !resolutions[t.rawTarget]).length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Sueldos (Excel)</CardTitle>
        <CardDescription>
          Importa personas, sueldos anuales, fuentes de financiamiento y líneas desde el archivo de
          Sueldos. La importación <span className="font-medium">agrega y actualiza</span>: nunca
          elimina lo que se haya ingresado a mano en{" "}
          <span className="font-medium">Sueldos</span>.
        </CardDescription>

        {lastUpload && (
          <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            <p>
              Último archivo: <span className="font-medium">{lastUpload.fileName}</span>
            </p>
            <p>
              Subido por: {lastUpload.uploadedBy} —{" "}
              {new Date(lastUpload.uploadedAt).toLocaleDateString("es-EC")}
            </p>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="sr-only"
            id={fileInputId}
            onChange={(e) => {
              setFileName(e.target.files?.[0]?.name ?? null);
              reset();
              setDone(null);
            }}
          />
          <label
            htmlFor={fileInputId}
            className="flex h-9 flex-1 cursor-pointer items-center gap-2 rounded-md border border-dashed border-input px-3 text-sm transition-colors hover:bg-accent/50"
          >
            <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={fileName ? "truncate" : "text-muted-foreground"}>
              {fileName || "Seleccionar archivo .xlsx"}
            </span>
          </label>
        </div>

        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="sueldos-import-year" className="text-xs">
              Año de los sueldos
            </Label>
            <Input
              id="sueldos-import-year"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder="del nombre de la hoja"
              className="h-9 w-[190px]"
              inputMode="numeric"
            />
          </div>
          <Button onClick={runPreview} disabled={pending || !fileName} size="sm" variant="outline">
            {pending && !preview ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            <span className={pending && !preview ? "ml-1" : ""}>Revisar</span>
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {done && (
          <div className="flex items-start gap-2 text-sm text-green-700 dark:text-green-400">
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{done}</span>
          </div>
        )}

        {preview && (
          <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">
              Se importará para el año {preview.requestedYear}
              {preview.detectedYear && preview.detectedYear !== preview.requestedYear && (
                <span className="font-normal text-amber-700 dark:text-amber-500">
                  {" "}
                  (la hoja indica {preview.detectedYear})
                </span>
              )}
            </p>

            <ul className="space-y-0.5 text-muted-foreground">
              <li>{preview.newPeople.length} persona(s) nueva(s)</li>
              <li>{preview.salaryChanges.length} sueldo(s) a modificar</li>
              <li>{preview.unchangedCount} sueldo(s) sin cambios</li>
              <li>
                {preview.newSources.length} fuente(s) nueva(s), {preview.existingSourceCount}{" "}
                existente(s)
              </li>
              <li>{preview.allocationCount} línea(s) de financiamiento</li>
            </ul>

            {preview.salaryChanges.length > 0 && (
              <details className="rounded border bg-background p-2">
                <summary className="cursor-pointer text-xs font-medium">
                  Sueldos que cambiarán ({preview.salaryChanges.length})
                </summary>
                <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                  {preview.salaryChanges.map((c) => (
                    <li key={c.name} className="flex items-center gap-1.5">
                      <span className="font-medium text-foreground">{c.name}</span>
                      <span>{c.from == null ? "(sin sueldo)" : formatMoney(c.from)}</span>
                      <ArrowRight className="h-3 w-3" />
                      <span>{formatMoney(c.to)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {preview.warnings.length > 0 && (
              <div className="space-y-1">
                {preview.warnings.map((w, i) => (
                  <p
                    key={i}
                    className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{w}</span>
                  </p>
                ))}
              </div>
            )}

            {preview.unresolvedTargets.length > 0 && (
              <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/30">
                <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                  Nombres sin coincidencia — indique a quién corresponden antes de importar:
                </p>
                {preview.unresolvedTargets.map((t) => (
                  <div key={t.rawTarget} className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">
                      {t.rawTarget}{" "}
                      <span className="font-normal text-muted-foreground">
                        ({t.lineCount} línea{t.lineCount === 1 ? "" : "s"})
                      </span>
                    </span>
                    <select
                      value={resolutions[t.rawTarget] ?? ""}
                      onChange={(e) =>
                        setResolutions((prev) => {
                          const next = { ...prev };
                          if (e.target.value) next[t.rawTarget] = e.target.value;
                          else delete next[t.rawTarget];
                          return next;
                        })
                      }
                      className="h-7 rounded border border-input bg-background px-2 text-xs"
                    >
                      <option value="">— seleccionar —</option>
                      {t.suggestions.length > 0 && (
                        <optgroup label="Sugerencias">
                          {t.suggestions.map((s) => {
                            const opt = preview.resolutionOptions.find((o) => o.label === s);
                            return opt ? (
                              <option key={`sug-${opt.value}`} value={opt.value}>
                                {opt.label}
                              </option>
                            ) : null;
                          })}
                        </optgroup>
                      )}
                      <optgroup label="Todos">
                        {preview.resolutionOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <Button onClick={runCommit} disabled={pending || unresolvedRemaining > 0} size="sm">
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                <span className={pending ? "ml-1" : ""}>Importar</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={reset} disabled={pending}>
                Cancelar
              </Button>
              {unresolvedRemaining > 0 && (
                <span className="text-xs text-amber-700 dark:text-amber-500">
                  Faltan {unresolvedRemaining} correspondencia(s)
                </span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
