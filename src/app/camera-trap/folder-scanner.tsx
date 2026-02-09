"use client";

import { useState, useTransition } from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PathInput } from "@/components/path-input";
import { FolderBrowser } from "@/components/folder-browser";
import { scanFolder, createDeployment } from "./actions";
import type { ActionResult } from "@/lib/types";
import type { ScannedImage } from "@/lib/image-scanner";

const initialState: ActionResult<{ images: ScannedImage[]; totalSize: number }> = {
  success: false,
  error: "",
};

export function FolderScanner() {
  const router = useRouter();
  const [scanState, scanAction, scanning] = useActionState(
    scanFolder,
    initialState
  );
  const [step, setStep] = useState<"input" | "preview" | "creating">("input");
  const [folderPath, setFolderPath] = useState("");
  const [isPending, startTransition] = useTransition();

  const [deploymentName, setDeploymentName] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");

  const handleReset = () => {
    setStep("input");
    setFolderPath("");
    setDeploymentName("");
    setLatitude("");
    setLongitude("");
    setDateStart("");
    setDateEnd("");
  };

  const handleCreateDeployment = async () => {
    if (!scanState.success || !folderPath) return;

    setStep("creating");

    startTransition(async () => {
      const result = await createDeployment(folderPath, scanState.data.images, {
        name: deploymentName || undefined,
        latitude: latitude ? parseFloat(latitude) : undefined,
        longitude: longitude ? parseFloat(longitude) : undefined,
        dateStart: dateStart || undefined,
        dateEnd: dateEnd || undefined,
      });

      if (!result.success) {
        alert(`Error al crear despliegue: ${result.error}`);
        setStep("preview");
        return;
      }

      router.push(`/camera-trap/${result.data.deploymentId}`);
    });
  };

  // When scan succeeds, show preview
  if (scanState.success && step === "input") {
    setStep("preview");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          {step === "input" && "Registrar Despliegue"}
          {step === "preview" && "Detalles del Despliegue"}
          {step === "creating" && "Creando despliegue..."}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {step === "input" && (
          <form action={scanAction} className="space-y-4">
            <div className="space-y-2">
              <Label>Ruta de la carpeta</Label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <PathInput
                    name="path"
                    placeholder="/ruta/a/imagenes/TP-001"
                    error={!scanState.success && scanState.error ? scanState.error : undefined}
                    onChange={(value) => setFolderPath(value)}
                    value={folderPath}
                    required
                  />
                </div>
                <FolderBrowser
                  onSelect={(selectedPath) => setFolderPath(selectedPath)}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Escribe una ruta o navega para seleccionar una carpeta de imágenes
              </p>
            </div>

            <Button type="submit" disabled={scanning} className="w-full">
              {scanning ? "Escaneando..." : "Escanear Carpeta"}
            </Button>
          </form>
        )}

        {step === "preview" && scanState.success && (
          <div className="space-y-4">
            <div className="p-4 bg-muted rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium">Imágenes encontradas</span>
                <span className="text-2xl font-bold">
                  {scanState.data.images.length}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>Tamaño total</span>
                <span>{formatBytes(scanState.data.totalSize)}</span>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-medium text-muted-foreground">
                Metadatos opcionales
              </p>

              <div>
                <Label htmlFor="deploymentName">Nombre del despliegue</Label>
                <Input
                  id="deploymentName"
                  placeholder="ej. TP-001 Cámara Cresta"
                  value={deploymentName}
                  onChange={(e) => setDeploymentName(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="latitude">Latitud</Label>
                  <Input
                    id="latitude"
                    type="number"
                    step="any"
                    placeholder="-0.1234"
                    value={latitude}
                    onChange={(e) => setLatitude(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="longitude">Longitud</Label>
                  <Input
                    id="longitude"
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
                  <Label htmlFor="dateStart">Fecha inicio</Label>
                  <Input
                    id="dateStart"
                    type="date"
                    value={dateStart}
                    onChange={(e) => setDateStart(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="dateEnd">Fecha fin</Label>
                  <Input
                    id="dateEnd"
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
                onClick={handleReset}
                className="flex-1"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleCreateDeployment}
                className="flex-1"
                disabled={isPending}
              >
                {isPending ? "Creando..." : "Crear Despliegue"}
              </Button>
            </div>
          </div>
        )}

        {step === "creating" && (
          <div className="text-center py-8 space-y-4">
            <div className="text-4xl animate-pulse">📷</div>
            <p className="text-muted-foreground">
              Creando despliegue y generando miniaturas...
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
