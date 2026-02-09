"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createProcessingJob, getMLStatus } from "../actions";

const DETECTOR_MODELS = [
  { value: "MDV6-yolov9-c", label: "MegaDetector V6 (YOLOv9-c)" },
  { value: "MDV6-yolov9-e", label: "MegaDetector V6 (YOLOv9-e)" },
];

const CLASSIFIER_MODELS = [
  { value: "AI4GAmazonRainforest", label: "AI4G Amazon Rainforest" },
  { value: "none", label: "Solo detección (sin clasificación)" },
];

export function ProcessButton({ deploymentId }: { deploymentId: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const [detectorModel, setDetectorModel] = useState("MDV6-yolov9-c");
  const [classifierModel, setClassifierModel] = useState("AI4GAmazonRainforest");
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.1);

  const [mlStatus, setMlStatus] = useState<{
    available: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (open && !mlStatus) {
      getMLStatus().then(setMlStatus);
    }
  }, [open, mlStatus]);

  const handleProcess = () => {
    startTransition(async () => {
      const result = await createProcessingJob(deploymentId, {
        detectorModel,
        classifierModel,
        confidenceThreshold,
      });

      if (!result.success) {
        alert(`Error al crear trabajo: ${result.error}`);
        return;
      }

      setOpen(false);
      router.push(`/camera-trap/process?jobId=${result.data.jobId}`);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Procesar Imágenes</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configurar Procesamiento</DialogTitle>
          <DialogDescription>
            Elige los modelos y parámetros para este procesamiento.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Modelo de Detección</Label>
            <Select value={detectorModel} onValueChange={setDetectorModel}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DETECTOR_MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Modelo de Clasificación</Label>
            <Select value={classifierModel} onValueChange={setClassifierModel}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLASSIFIER_MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Umbral de Confianza: {confidenceThreshold.toFixed(2)}</Label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={confidenceThreshold}
              onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
              className="w-full accent-primary"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0.00 (todas las detecciones)</span>
              <span>1.00 (solo alta confianza)</span>
            </div>
          </div>

          {mlStatus && (
            <div
              className={`rounded-md p-3 text-sm border ${
                mlStatus.available
                  ? "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-900 text-green-700 dark:text-green-300"
                  : "bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-300"
              }`}
            >
              {mlStatus.available
                ? `ML disponible: ${mlStatus.message}`
                : `ML no disponible: ${mlStatus.message}`}
            </div>
          )}

          {mlStatus && !mlStatus.available && (
            <div className="rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-900 p-3 text-sm text-red-700 dark:text-red-300">
              ML no está disponible. Configura{" "}
              <code className="font-mono bg-red-100 dark:bg-red-900 px-1 rounded">
                ML_PYTHON_PATH
              </code>{" "}
              en .env.local con la ruta a Python con pytorch-wildlife instalado.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={handleProcess} disabled={isPending || (mlStatus !== null && !mlStatus.available)}>
            {isPending ? "Iniciando..." : "Iniciar Procesamiento"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
