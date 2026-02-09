"use client";

import { useState, useTransition, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAvailableSites, previewAddSite, commitAddSite } from "./actions";
import type { AvailableSite, AddSitePreview } from "./actions";

export function AddSite() {
  const [sites, setSites] = useState<AvailableSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [preview, setPreview] = useState<AddSitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    getAvailableSites().then((result) => {
      if (result.success && result.data) setSites(result.data);
      else setError(result.error ?? "Error al cargar sitios");
      setLoading(false);
    });
  }, []);

  const selectedSite = sites.find((s) => s.siteId === selectedSiteId);

  function handlePreview() {
    if (!selectedSite) return;
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await previewAddSite(selectedSite.siteId, selectedSite.siteName, selectedSite.habitatType);
      if (result.success && result.data) {
        setPreview(result.data);
      } else {
        setError(result.error ?? "Error desconocido");
      }
    });
  }

  function handleCommit() {
    if (!selectedSite) return;
    setError(null);
    startTransition(async () => {
      const result = await commitAddSite(selectedSite.siteId, selectedSite.siteName, selectedSite.habitatType);
      if (result.success) {
        setSuccess("Sitio agregado al cronograma correctamente.");
        setPreview(null);
        setSites((prev) => prev.filter((s) => s.siteId !== selectedSite.siteId));
        setSelectedSiteId("");
      } else {
        setError(result.error ?? "Error al guardar");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agregar Nuevo Sitio al Cronograma</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Agregar un nuevo sitio de monitoreo desde ODK Central. Se crearán <strong>3 visitas</strong> espaciadas ~6 meses.
        </p>

        {loading ? (
          <p className="text-sm text-muted-foreground">Cargando sitios desde ODK Central...</p>
        ) : sites.length === 0 ? (
          <p className="text-sm text-green-600 font-medium">Todos los sitios de ODK Central ya están en el cronograma.</p>
        ) : (
          <>
            <div>
              <label className="text-sm font-medium">Seleccionar un sitio</label>
              <select
                value={selectedSiteId}
                onChange={(e) => { setSelectedSiteId(e.target.value); setPreview(null); }}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Seleccionar...</option>
                {sites.map((s) => (
                  <option key={s.siteId} value={s.siteId}>
                    {s.siteId} - {s.siteName} ({s.habitatType})
                  </option>
                ))}
              </select>
            </div>

            {selectedSite && (
              <div className="grid grid-cols-3 gap-4">
                <Card className="py-2">
                  <CardContent className="text-center">
                    <p className="text-xs text-muted-foreground">ID Sitio</p>
                    <p className="font-mono font-bold">{selectedSite.siteId}</p>
                  </CardContent>
                </Card>
                <Card className="py-2">
                  <CardContent className="text-center">
                    <p className="text-xs text-muted-foreground">Hábitat</p>
                    <p className="font-bold">{selectedSite.habitatType}</p>
                  </CardContent>
                </Card>
                <Card className="py-2">
                  <CardContent className="text-center">
                    <p className="text-xs text-muted-foreground">Ubicación</p>
                    <p className="font-bold text-sm">
                      {selectedSite.lat && selectedSite.lng
                        ? `${selectedSite.lat.toFixed(4)}, ${selectedSite.lng.toFixed(4)}`
                        : "No establecida"}
                    </p>
                  </CardContent>
                </Card>
              </div>
            )}

            {selectedSite && !preview && (
              <Button onClick={handlePreview} disabled={isPending} variant="secondary">
                {isPending ? "Calculando..." : "Generar 3 Visitas"}
              </Button>
            )}
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-green-600 font-medium">{success}</p>}

        {preview && (
          <div className="space-y-4">
            <p className="text-sm font-medium">{preview.newDeployments.length} nuevas instalaciones:</p>

            <div className="rounded-xl border overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Visita</TableHead>
                    <TableHead>Instalación</TableHead>
                    <TableHead>Recuperación</TableHead>
                    <TableHead>Temporada</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.newDeployments.map((d) => (
                    <TableRow key={d.deploymentId}>
                      <TableCell className="font-mono text-xs">{d.deploymentId}</TableCell>
                      <TableCell>{d.visitNumber}</TableCell>
                      <TableCell className="tabular-nums">{d.plannedDeployDate}</TableCell>
                      <TableCell className="tabular-nums">{d.plannedRetrieveDate}</TableCell>
                      <TableCell>{d.season}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {preview.validationErrors.length > 0 ? (
              <div className="rounded-md bg-yellow-50 p-3 text-sm">
                <p className="font-medium text-yellow-800">{preview.validationErrors.length} advertencias:</p>
                <ul className="mt-1 list-disc pl-5 text-yellow-700">
                  {preview.validationErrors.slice(0, 5).map((e, i) => (
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
                {isPending ? "Guardando..." : "Aplicar al Cronograma"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
