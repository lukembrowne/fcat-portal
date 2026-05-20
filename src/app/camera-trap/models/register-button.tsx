"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { registerModelFromDir, type UnregisteredModelDir } from "./actions";

interface RegistrationWarning {
  dirName: string;
  version: string;
  unmatchedClasses: string[];
}

export function RegisterDirsList({ dirs }: { dirs: UnregisteredModelDir[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<RegistrationWarning | null>(null);
  const [busyDir, setBusyDir] = useState<string | null>(null);
  const [allowUntracked, setAllowUntracked] = useState<Record<string, boolean>>(
    {},
  );

  function handleRegister(dirName: string) {
    setError(null);
    setWarning(null);
    setBusyDir(dirName);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("dirName", dirName);
      if (allowUntracked[dirName]) formData.set("allowUntracked", "on");
      const res = await registerModelFromDir(formData);
      setBusyDir(null);
      if (res.success) {
        if (res.data.unmatchedClasses.length > 0) {
          setWarning({
            dirName,
            version: res.data.version,
            unmatchedClasses: res.data.unmatchedClasses,
          });
        }
        router.refresh();
      } else {
        setError(`${dirName}: ${res.error}`);
      }
    });
  }

  return (
    <div>
      {error && (
        <div className="mb-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive whitespace-pre-wrap">
          {error}
        </div>
      )}
      {warning && (
        <div className="mb-3 rounded border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">
            Modelo {warning.version} registrado, pero{" "}
            {warning.unmatchedClasses.length}{" "}
            {warning.unmatchedClasses.length === 1
              ? "clase no coincide"
              : "clases no coinciden"}{" "}
            con la tabla de especies.
          </p>
          <p className="mt-1 text-xs">
            Las detecciones generadas por estas clases no enlazarán con los
            nombres en inglés/español y aparecerán como una especie aparte.
            Para que enlacen, re-entrena el modelo a partir de un nuevo
            exporte (cuyas carpetas usan los nombres científicos canónicos).
          </p>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer">
              Ver clases sin coincidencia
            </summary>
            <ul className="mt-1 ml-4 list-disc max-h-40 overflow-y-auto font-mono">
              {warning.unmatchedClasses.slice(0, 50).map((c) => (
                <li key={c}>{c}</li>
              ))}
              {warning.unmatchedClasses.length > 50 && (
                <li>… y {warning.unmatchedClasses.length - 50} más</li>
              )}
            </ul>
          </details>
        </div>
      )}
      <ul className="space-y-2">
        {dirs.map((d) => {
          const ready = d.hasWeights && d.hasMetrics && d.hasClassMapping;
          return (
            <li
              key={d.dirName}
              className="border rounded p-3 flex items-center gap-3 flex-wrap"
            >
              <code className="font-mono text-sm flex-1">{d.dirName}</code>

              <Badge variant={d.hasWeights ? "default" : "destructive"}>
                weights.pt
              </Badge>
              <Badge variant={d.hasMetrics ? "default" : "destructive"}>
                metrics.json
              </Badge>
              <Badge variant={d.hasClassMapping ? "default" : "destructive"}>
                class_mapping.json
              </Badge>

              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allowUntracked[d.dirName] ?? false}
                  onChange={(e) =>
                    setAllowUntracked((prev) => ({
                      ...prev,
                      [d.dirName]: e.target.checked,
                    }))
                  }
                  disabled={isPending}
                />
                Permitir dataset no registrado
              </label>

              <Button
                size="sm"
                disabled={!ready || isPending}
                onClick={() => handleRegister(d.dirName)}
              >
                {busyDir === d.dirName ? "Registrando…" : "Registrar"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
