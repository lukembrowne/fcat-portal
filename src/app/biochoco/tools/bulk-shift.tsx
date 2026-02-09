"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { previewBulkShift, commitBulkShift } from "./actions";
import type { ShiftPreview } from "./actions";

export function BulkShift({ hasSlots, scheduledCount }: { hasSlots: boolean; scheduledCount: number }) {
  const [amount, setAmount] = useState(0);
  const [preview, setPreview] = useState<ShiftPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const unit = hasSlots ? "ranuras" : "días";

  function handlePreview() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await previewBulkShift(amount, hasSlots);
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
      const result = await commitBulkShift(amount, hasSlots, preview!.hash);
      if (result.success) {
        setSuccess("Cronograma actualizado correctamente.");
        setPreview(null);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cambio Masivo del Cronograma Restante</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Desplazar todas las instalaciones <strong>programadas</strong> ({scheduledCount}) por un número de {unit}.
          {hasSlots && " Cada ranura = 1 día hábil. ~20 ranuras = 1 mes."}
        </p>

        <div className="flex items-center gap-4">
          <div className="w-48">
            <label className="text-sm font-medium">{hasSlots ? "Ranuras" : "Días"} a desplazar</label>
            <Input
              type="number"
              value={amount}
              onChange={(e) => setAmount(parseInt(e.target.value, 10) || 0)}
              min={-100}
              max={100}
            />
          </div>
          <div className="pt-5 text-sm">
            {amount > 0 && <span className="text-green-600">→ Desplazar {amount} {unit} después</span>}
            {amount < 0 && <span className="text-orange-600">← Desplazar {Math.abs(amount)} {unit} antes</span>}
            {amount === 0 && <span className="text-muted-foreground">Sin cambio</span>}
          </div>
        </div>

        {amount !== 0 && (
          <Button onClick={handlePreview} disabled={isPending} variant="secondary">
            {isPending ? "Calculando..." : "Vista Previa de Cambios"}
          </Button>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-green-600 font-medium">{success}</p>}

        {preview && (
          <div className="space-y-4">
            <p className="text-sm font-medium">
              {preview.changes.length} cambios de campo
            </p>

            {preview.changes.length > 0 && (
              <div className="rounded-xl border overflow-auto max-h-80">
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
            )}

            {preview.validationErrors.length > 0 ? (
              <div className="rounded-md bg-yellow-50 p-3 text-sm">
                <p className="font-medium text-yellow-800">{preview.validationErrors.length} advertencias:</p>
                <ul className="mt-1 list-disc pl-5 text-yellow-700">
                  {preview.validationErrors.slice(0, 10).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-green-600 font-medium">El nuevo cronograma pasa todas las verificaciones.</p>
            )}

            <div className="border-t pt-4">
              <p className="text-sm text-muted-foreground mb-2">Esto modificará la hoja de Google Sheets.</p>
              <Button onClick={handleCommit} disabled={isPending}>
                {isPending ? "Guardando..." : "Aplicar Cambios"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
