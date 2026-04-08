"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { setActiveModel, deleteModel } from "./actions";

export interface ModelRow {
  id: number;
  version: string;
  modelDir: string;
  confidenceThreshold: number;
  active: boolean;
  createdAt: string; // ISO
  createdBy: string;
  trainingDatasetVersion: string | null;
  top1Accuracy: number | null;
}

export function ModelsTable({ rows }: { rows: ModelRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Todavía no hay modelos registrados.
      </p>
    );
  }

  function handleActivate(modelId: number) {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("modelId", String(modelId));
      const res = await setActiveModel(formData);
      if (res.success) {
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  function handleDelete(modelId: number, version: string) {
    if (!confirm(`¿Borrar el modelo ${version}? Esta acción no borra los archivos en disco.`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("modelId", String(modelId));
      const res = await deleteModel(formData);
      if (res.success) {
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div>
      {error && (
        <div className="mb-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2 font-semibold">Versión</th>
              <th className="px-3 py-2 font-semibold">Dataset</th>
              <th className="px-3 py-2 font-semibold text-right">Top-1</th>
              <th className="px-3 py-2 font-semibold text-right">Umbral</th>
              <th className="px-3 py-2 font-semibold">Estado</th>
              <th className="px-3 py-2 font-semibold">Fecha</th>
              <th className="px-3 py-2 font-semibold">Creado por</th>
              <th className="px-3 py-2 font-semibold text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className="border-t">
                <td className="px-3 py-2 font-mono">{m.version}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {m.trainingDatasetVersion ?? (
                    <span className="text-muted-foreground italic">
                      no registrado
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {m.top1Accuracy != null
                    ? `${(m.top1Accuracy * 100).toFixed(1)}%`
                    : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  {m.confidenceThreshold.toFixed(2)}
                </td>
                <td className="px-3 py-2">
                  {m.active ? (
                    <Badge className="bg-green-600">Activo</Badge>
                  ) : (
                    <Badge variant="outline">Inactivo</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground text-xs">
                  {new Date(m.createdAt).toLocaleString("es-EC")}
                </td>
                <td className="px-3 py-2 text-muted-foreground text-xs">
                  {m.createdBy}
                </td>
                <td className="px-3 py-2 text-right space-x-2">
                  {!m.active && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isPending}
                      onClick={() => handleActivate(m.id)}
                    >
                      Activar
                    </Button>
                  )}
                  {!m.active && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isPending}
                      onClick={() => handleDelete(m.id, m.version)}
                    >
                      Borrar
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
