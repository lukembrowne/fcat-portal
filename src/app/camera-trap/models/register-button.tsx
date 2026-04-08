"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { registerModelFromDir, type UnregisteredModelDir } from "./actions";

export function RegisterDirsList({ dirs }: { dirs: UnregisteredModelDir[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyDir, setBusyDir] = useState<string | null>(null);
  const [allowUntracked, setAllowUntracked] = useState<Record<string, boolean>>(
    {},
  );

  function handleRegister(dirName: string) {
    setError(null);
    setBusyDir(dirName);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("dirName", dirName);
      if (allowUntracked[dirName]) formData.set("allowUntracked", "on");
      const res = await registerModelFromDir(formData);
      setBusyDir(null);
      if (res.success) {
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
