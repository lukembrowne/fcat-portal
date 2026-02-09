"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { previewSyncOdk, commitSyncOdk } from "./actions";
import type { SyncUpdate } from "./actions";

export function SyncOdk() {
  const [updates, setUpdates] = useState<SyncUpdate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCheck() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await previewSyncOdk();
      if (result.success && result.data) {
        setUpdates(result.data);
      } else {
        setError(result.error ?? "Error desconocido");
      }
    });
  }

  function handleCommit() {
    if (!updates) return;
    setError(null);
    startTransition(async () => {
      const result = await commitSyncOdk(updates);
      if (result.success) {
        setSuccess("Estado y fechas actualizados correctamente.");
        setUpdates(null);
      } else {
        setError(result.error ?? "Error al guardar");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sincronizar Estado desde ODK</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Actualiza el estado y fechas del cronograma basado en los datos de ODK Central.
        </p>

        <Button onClick={handleCheck} disabled={isPending} variant="secondary">
          {isPending ? "Verificando..." : "Buscar Actualizaciones"}
        </Button>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-green-600 font-medium">{success}</p>}

        {updates !== null && (
          updates.length > 0 ? (
            <div className="space-y-4">
              <p className="text-sm font-medium">{updates.length} actualizaciones pendientes:</p>

              <div className="rounded-xl border overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID Instalación</TableHead>
                      <TableHead>ID Sitio</TableHead>
                      <TableHead>Estado Anterior</TableHead>
                      <TableHead>Nuevo Estado</TableHead>
                      <TableHead>Fecha Real</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {updates.map((u) => (
                      <TableRow key={u.deploymentId}>
                        <TableCell className="font-mono text-xs">{u.deploymentId}</TableCell>
                        <TableCell>{u.siteId}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{u.oldStatus}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={u.newStatus === "retrieved" ? "secondary" : "default"}>
                            {u.newStatus}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {u.actualDeployDate ?? u.actualRetrieveDate ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="border-t pt-4">
                <p className="text-sm text-muted-foreground mb-2">Esto modificará la hoja de Google Sheets.</p>
                <Button onClick={handleCommit} disabled={isPending}>
                  {isPending ? "Guardando..." : "Aplicar Cambios"}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-green-600 font-medium">El cronograma está sincronizado con ODK.</p>
          )
        )}
      </CardContent>
    </Card>
  );
}
