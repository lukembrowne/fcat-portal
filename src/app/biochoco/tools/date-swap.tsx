"use client";

import { useState, useTransition, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ScheduleRow } from "@/lib/schedule-types";
import { previewDateSwap, commitDateSwap } from "./actions";
import type { SwapPreview } from "./actions";

export function DateSwap({ schedule }: { schedule: ScheduleRow[] }) {
  const [id1, setId1] = useState("");
  const [id2, setId2] = useState("");
  const [preview, setPreview] = useState<SwapPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const scheduled = useMemo(
    () => schedule.filter((r) => r.status === "scheduled").sort((a, b) =>
      (a.plannedDeployDate ?? "").localeCompare(b.plannedDeployDate ?? "")
    ),
    [schedule],
  );

  function makeLabel(r: ScheduleRow): string {
    return `${r.deploymentId} - ${r.siteName} (${r.plannedDeployDate ?? "sin fecha"})`;
  }

  function handlePreview() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await previewDateSwap(id1, id2);
      if (result.success) {
        setPreview(result.data);
      } else {
        setError(result.error);
      }
    });
  }

  function handleCommit() {
    setError(null);
    startTransition(async () => {
      const result = await commitDateSwap(id1, id2, preview!.hash);
      if (result.success) {
        setSuccess("Fechas intercambiadas correctamente.");
        setPreview(null);
      } else {
        setError(result.error);
      }
    });
  }

  if (scheduled.length < 2) {
    return (
      <Card>
        <CardHeader><CardTitle>Intercambiar Fechas entre Instalaciones</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Se necesitan al menos 2 instalaciones programadas.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Intercambiar Fechas entre Instalaciones</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Intercambiar las fechas programadas entre dos instalaciones.
          {" "}{scheduled.length} instalaciones programadas disponibles.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium">Primera Instalación</label>
            <select
              value={id1}
              onChange={(e) => setId1(e.target.value)}
              className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Seleccionar...</option>
              {scheduled.map((r) => (
                <option key={r.deploymentId} value={r.deploymentId} disabled={r.deploymentId === id2}>
                  {makeLabel(r)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium">Segunda Instalación</label>
            <select
              value={id2}
              onChange={(e) => setId2(e.target.value)}
              className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Seleccionar...</option>
              {scheduled.map((r) => (
                <option key={r.deploymentId} value={r.deploymentId} disabled={r.deploymentId === id1}>
                  {makeLabel(r)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {id1 && id2 && (
          <Button onClick={handlePreview} disabled={isPending} variant="secondary">
            {isPending ? "Calculando..." : "Vista Previa del Intercambio"}
          </Button>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-green-600 font-medium">{success}</p>}

        {preview && (
          <div className="space-y-4">
            <div className="rounded-xl border overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Campo</TableHead>
                    <TableHead>Antes</TableHead>
                    <TableHead>Después</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.changes.map((c, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{c.deploymentId}</TableCell>
                      <TableCell>{c.field}</TableCell>
                      <TableCell className="tabular-nums">{c.oldValue}</TableCell>
                      <TableCell className="tabular-nums">{c.newValue}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="border-t pt-4">
              <p className="text-sm text-muted-foreground mb-2">Esto modificará la hoja de Google Sheets.</p>
              <Button onClick={handleCommit} disabled={isPending}>
                {isPending ? "Guardando..." : "Aplicar Intercambio"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
