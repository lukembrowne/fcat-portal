"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { enqueueExternalImport, type ImportDispatchResult } from "./lila-actions";

interface Props {
  datasetOptions: Array<{ slug: string; name: string }>;
  classOptions: string[];
}

export function ImportForm({ datasetOptions, classOptions }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportDispatchResult | null>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await enqueueExternalImport(formData);
      setResult(res);
      if (res.success) {
        // Wake the floating progress bar immediately.
        window.dispatchEvent(new Event("job-started"));
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <form action={handleSubmit} className="mt-3 space-y-5">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Conjuntos de datos</legend>
        {datasetOptions.map((d) => (
          <label key={d.slug} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="dataset" value={d.slug} defaultChecked />
            {d.name}
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Clases a aumentar</legend>
        <p className="text-xs text-muted-foreground">
          Por defecto se importan las clases poco representadas. Se importan
          hasta <strong>1000 imágenes por clase</strong> (o menos si LILA no
          tiene suficientes con caja).
        </p>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {classOptions.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="class" value={c} defaultChecked />
              <span className="truncate" title={c}>
                {c}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Iniciando…" : "Importar"}
        </Button>
        {result?.success && (
          <span className="text-sm text-muted-foreground">
            Importación iniciada (trabajo #{result.jobId}).
          </span>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>

      <Label className="block text-xs text-muted-foreground">
        La importación corre en segundo plano; sigue el progreso en la barra
        flotante.
      </Label>
    </form>
  );
}
