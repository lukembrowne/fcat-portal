"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  discoverDeployments,
  activateDeployment,
  scanDeploymentImages,
} from "./drive-actions";
import type { DriveFolder } from "@/lib/drive-client";

type Step = "idle" | "discovering" | "results" | "activating";

export function DeploymentDiscovery() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("idle");
  const [discovered, setDiscovered] = useState<DriveFolder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Activation form state
  const [selectedFolder, setSelectedFolder] = useState<DriveFolder | null>(
    null
  );
  const [name, setName] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");

  const handleDiscover = () => {
    setError(null);
    setStep("discovering");

    startTransition(async () => {
      const result = await discoverDeployments();
      if (!result.success) {
        setError(result.error);
        setStep("idle");
        return;
      }

      setDiscovered(result.data.discovered);
      setStep("results");
    });
  };

  const handleSelectFolder = (folder: DriveFolder) => {
    setSelectedFolder(folder);
    setName(folder.name);
    setLatitude("");
    setLongitude("");
    setDateStart("");
    setDateEnd("");
    setStep("activating");
  };

  const handleActivate = () => {
    if (!selectedFolder) return;

    setError(null);
    startTransition(async () => {
      const result = await activateDeployment(
        selectedFolder.id,
        name || selectedFolder.name,
        {
          latitude: latitude ? parseFloat(latitude) : undefined,
          longitude: longitude ? parseFloat(longitude) : undefined,
          dateStart: dateStart || undefined,
          dateEnd: dateEnd || undefined,
        }
      );

      if (!result.success) {
        setError(result.error);
        return;
      }

      // Auto-scan images after activation
      await scanDeploymentImages(result.data.deploymentId);

      router.push(`/camera-trap/${result.data.deploymentId}`);
    });
  };

  const handleReset = () => {
    setStep("idle");
    setDiscovered([]);
    setSelectedFolder(null);
    setError(null);
    setName("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          {step === "idle" && "Registrar Despliegue"}
          {step === "discovering" && "Buscando carpetas..."}
          {step === "results" && "Carpetas Disponibles"}
          {step === "activating" && "Detalles del Despliegue"}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Idle: Show discover button */}
        {step === "idle" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Busca nuevas carpetas de despliegue en Google Drive para
              registrarlas en el sistema.
            </p>
            <Button
              onClick={handleDiscover}
              disabled={isPending}
              className="w-full"
            >
              Buscar Nuevas Carpetas
            </Button>
          </div>
        )}

        {/* Discovering: Loading state */}
        {step === "discovering" && (
          <div className="text-center py-6">
            <div className="text-2xl animate-pulse mb-2">🔍</div>
            <p className="text-sm text-muted-foreground">
              Buscando carpetas en Google Drive...
            </p>
          </div>
        )}

        {/* Results: Show discovered folders */}
        {step === "results" && (
          <div className="space-y-3">
            {discovered.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">
                  No se encontraron nuevas carpetas de despliegue.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Todas las carpetas en Drive ya están registradas.
                </p>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {discovered.length} carpeta{discovered.length !== 1 && "s"}{" "}
                  nueva{discovered.length !== 1 && "s"} encontrada
                  {discovered.length !== 1 && "s"}:
                </p>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {discovered.map((folder) => (
                    <button
                      key={folder.id}
                      onClick={() => handleSelectFolder(folder)}
                      className="w-full text-left p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                    >
                      <p className="font-medium text-sm">{folder.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        ID: {folder.id}
                      </p>
                    </button>
                  ))}
                </div>
              </>
            )}

            <Button variant="outline" onClick={handleReset} className="w-full">
              Volver
            </Button>
          </div>
        )}

        {/* Activating: Metadata form */}
        {step === "activating" && selectedFolder && (
          <div className="space-y-4">
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-sm font-medium">{selectedFolder.name}</p>
              <p className="text-xs text-muted-foreground">
                ID: {selectedFolder.id}
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <Label htmlFor="deployName">Nombre del despliegue</Label>
                <Input
                  id="deployName"
                  placeholder="ej. TP-001 Cámara Cresta"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="lat">Latitud</Label>
                  <Input
                    id="lat"
                    type="number"
                    step="any"
                    placeholder="-0.1234"
                    value={latitude}
                    onChange={(e) => setLatitude(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="lon">Longitud</Label>
                  <Input
                    id="lon"
                    type="number"
                    step="any"
                    placeholder="-79.5678"
                    value={longitude}
                    onChange={(e) => setLongitude(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="dStart">Fecha inicio</Label>
                  <Input
                    id="dStart"
                    type="date"
                    value={dateStart}
                    onChange={(e) => setDateStart(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="dEnd">Fecha fin</Label>
                  <Input
                    id="dEnd"
                    type="date"
                    value={dateEnd}
                    onChange={(e) => setDateEnd(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setStep("results")}
                className="flex-1"
                disabled={isPending}
              >
                Cancelar
              </Button>
              <Button
                onClick={handleActivate}
                className="flex-1"
                disabled={isPending}
              >
                {isPending ? "Activando..." : "Activar Despliegue"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
