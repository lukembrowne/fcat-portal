"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  getMissingDriveFolders,
  createSingleDriveFolder,
} from "./drive-folder-actions";
import type { MissingDeployment, FolderResult } from "./drive-folder-actions";

export function CreateFoldersPanel() {
  const [missing, setMissing] = useState<MissingDeployment[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creatingIds, setCreatingIds] = useState<string[]>([]);
  const [results, setResults] = useState<FolderResult[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSearch() {
    setError(null);
    setResults([]);
    setCreatingIds([]);
    setSelected(new Set());
    setCreating(false);
    startTransition(async () => {
      const result = await getMissingDriveFolders();
      if (result.success) {
        setMissing(result.data);
        setSelected(new Set(result.data.map((d) => d.deploymentId)));
      } else {
        setError(result.error);
      }
    });
  }

  function handleToggle(deploymentId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(deploymentId)) {
        next.delete(deploymentId);
      } else {
        next.add(deploymentId);
      }
      return next;
    });
  }

  function handleToggleAll() {
    if (!missing) return;
    if (selected.size === missing.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(missing.map((d) => d.deploymentId)));
    }
  }

  async function handleCreate() {
    if (selected.size === 0) return;

    const ids = [...selected].sort();
    setCreating(true);
    setCreatingIds(ids);
    setResults([]);
    setError(null);
    setMissing(null);

    for (const id of ids) {
      const result = await createSingleDriveFolder(id);
      setResults((prev) => [...prev, result]);
    }

    setCreating(false);
    setSelected(new Set());
  }

  const isWorking = isPending || creating;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crear Carpetas de Drive</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Busca instalaciones registradas en ODK que aún no tienen carpeta en
          Google Drive y crea las carpetas automáticamente.
        </p>

        <Button onClick={handleSearch} disabled={isWorking} variant="secondary">
          {isPending && !missing
            ? "Buscando..."
            : "Buscar Instalaciones sin Carpeta"}
        </Button>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Preview table */}
        {missing !== null && !creating &&
          (missing.length > 0 ? (
            <div className="space-y-4">
              <p className="text-sm font-medium">
                {missing.length} instalación(es) sin carpeta de Drive:
              </p>

              <div className="rounded-xl border overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={
                            selected.size === missing.length && missing.length > 0
                          }
                          onCheckedChange={handleToggleAll}
                          aria-label="Seleccionar todo"
                        />
                      </TableHead>
                      <TableHead>Instalación</TableHead>
                      <TableHead>Sitio</TableHead>
                      <TableHead>Fecha</TableHead>
                      <TableHead>En Cronograma</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {missing.map((d) => (
                      <TableRow key={d.deploymentId}>
                        <TableCell>
                          <Checkbox
                            checked={selected.has(d.deploymentId)}
                            onCheckedChange={() => handleToggle(d.deploymentId)}
                            aria-label={`Seleccionar ${d.deploymentId}`}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {d.deploymentId}
                        </TableCell>
                        <TableCell>
                          {d.siteName ?? d.siteId}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {d.dateInstalled ?? "—"}
                        </TableCell>
                        <TableCell>
                          {d.inSchedule ? (
                            <Badge variant="secondary">Sí</Badge>
                          ) : (
                            <Badge variant="outline">No</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="border-t pt-4">
                <p className="text-sm text-muted-foreground mb-2">
                  Esto creará carpetas en Google Drive con subcarpetas
                  (camaras_trampas, grabadores_de_audio, ibutton).
                </p>
                <Button
                  onClick={handleCreate}
                  disabled={isWorking || selected.size === 0}
                >
                  {`Crear ${selected.size} Carpeta${selected.size !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-green-600 font-medium">
              Todas las instalaciones ya tienen carpeta de Drive.
            </p>
          ))}

        {/* Progress during creation */}
        {(creating || (!creating && results.length > 0)) && creatingIds.length > 0 && (
          <div className="space-y-3">
            {creating ? (
              <p className="text-sm font-medium">
                Creando carpetas... ({results.length} de {creatingIds.length})
              </p>
            ) : (
              <p className="text-sm font-medium">
                Resultados: {results.filter((r) => r.success).length} de{" "}
                {results.length} carpeta(s) creadas
              </p>
            )}

            {/* Progress bar */}
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{
                  width: `${(results.length / creatingIds.length) * 100}%`,
                }}
              />
            </div>

            {/* Results table */}
            <div className="rounded-xl border overflow-auto max-h-72">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>Instalación</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {creatingIds.map((id, i) => {
                    const result = results.find((r) => r.deploymentId === id);
                    const isActive = creating && i === results.length;
                    const isPending = !result && !isActive;

                    return (
                      <TableRow key={id}>
                        <TableCell>
                          {result?.success ? (
                            <span className="text-green-600">&#10003;</span>
                          ) : result && !result.success ? (
                            <span className="text-destructive">&#10007;</span>
                          ) : isActive ? (
                            <span className="text-muted-foreground animate-spin inline-block">&#8635;</span>
                          ) : (
                            <span className="text-muted-foreground">&#8226;</span>
                          )}
                        </TableCell>
                        <TableCell className={`font-mono text-xs ${isPending ? "text-muted-foreground" : ""}`}>
                          {id}
                        </TableCell>
                        <TableCell className="text-sm">
                          {result?.success ? (
                            <a
                              href={result.folderLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              Carpeta creada
                            </a>
                          ) : result && !result.success ? (
                            <span className="text-destructive">{result.error}</span>
                          ) : isActive ? (
                            <span className="text-muted-foreground">Creando...</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
