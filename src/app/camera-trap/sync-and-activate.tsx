"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  discoverDeployments,
  activateDeployment,
  scanDeploymentImages,
} from "./drive-actions";
import type { DriveFolder } from "@/lib/drive-client";

type Step = "idle" | "syncing" | "results" | "activating";

export function SyncAndActivate() {
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

  const handleSync = () => {
    setError(null);
    setStep("syncing");

    startTransition(async () => {
      const result = await discoverDeployments();
      if (!result.success) {
        setError(result.error);
        setStep("idle");
        return;
      }

      if (result.data.discovered.length === 0) {
        // No new folders — just refresh the page to show updated data
        setStep("idle");
        router.refresh();
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

  const handleDismiss = () => {
    setStep("idle");
    setDiscovered([]);
    setSelectedFolder(null);
    setError(null);
    setName("");
  };

  return (
    <div className="mb-8">
      {/* Sync button — always visible */}
      <div className="flex items-center gap-3 mb-4">
        <Button
          onClick={handleSync}
          disabled={isPending || step === "syncing"}
          variant="outline"
          size="sm"
        >
          {step === "syncing" ? "Sincronizando..." : "Sincronizar con Drive ↻"}
        </Button>
        {step === "results" && discovered.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {discovered.length} carpeta{discovered.length !== 1 && "s"} nueva
            {discovered.length !== 1 && "s"}
          </span>
        )}
      </div>

      {error && (
        <div className="p-3 mb-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Discovered folders */}
      {step === "results" && discovered.length > 0 && (
        <Card className="mb-4">
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium">Carpetas Nuevas en Drive</h3>
              <Button variant="ghost" size="sm" onClick={handleDismiss}>
                Cerrar
              </Button>
            </div>
            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {discovered.map((folder) => (
                <button
                  key={folder.id}
                  onClick={() => handleSelectFolder(folder)}
                  className="text-left p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                >
                  <p className="font-medium text-sm">{folder.name}</p>
                  <a
                    href={`https://drive.google.com/drive/folders/${folder.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Abrir en Drive ↗
                  </a>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Activation form */}
      {step === "activating" && selectedFolder && (
        <Card className="mb-4">
          <CardContent className="py-4">
            <h3 className="font-medium mb-4">
              Activar Instalación
            </h3>
            <div className="p-3 bg-muted rounded-lg mb-4">
              <p className="text-sm font-medium">{selectedFolder.name}</p>
              <a
                href={`https://drive.google.com/drive/folders/${selectedFolder.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Abrir en Drive ↗
              </a>
            </div>

            <div className="space-y-3">
              <div>
                <Label htmlFor="deployName">Nombre de la instalación</Label>
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

            <div className="flex gap-2 mt-4">
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
                {isPending ? "Activando..." : "Activar Instalación"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
