"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { BBoxOverlay, type BBoxData } from "@/components/bbox-overlay";
import {
  AnnotationToolbar,
  type DetectionWithIdentification,
} from "@/components/annotation-toolbar";

interface AnnotateClientProps {
  jobId: number;
  deploymentName: string;
  imageId: number;
  imageFilename: string;
  imageSrc: string;
  boxes: BBoxData[];
  detections: DetectionWithIdentification[];
  speciesList: string[];
  imageIndex: number;
  totalImages: number;
  reviewed: number;
  totalIdentifications: number;
}

export function AnnotateClient({
  jobId,
  deploymentName,
  imageFilename,
  imageSrc,
  boxes,
  detections,
  speciesList,
  imageIndex,
  totalImages,
  reviewed,
  totalIdentifications,
}: AnnotateClientProps) {
  const router = useRouter();
  const [selectedBoxId, setSelectedBoxId] = useState<number | null>(null);

  const progressPercent =
    totalIdentifications > 0 ? (reviewed / totalIdentifications) * 100 : 0;

  const handleActionComplete = useCallback(() => {
    router.push(`/camera-trap/annotate?jobId=${jobId}`);
  }, [router, jobId]);

  const handleSkip = useCallback(() => {
    router.push(`/camera-trap/annotate?jobId=${jobId}`);
  }, [router, jobId]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (e.key === "s" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleSkip();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSkip]);

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href="/camera-trap" className="hover:underline">
              Cámaras Trampa
            </Link>
            <span>/</span>
            <Link
              href={`/camera-trap/results/${jobId}`}
              className="hover:underline"
            >
              Trabajo #{jobId}
            </Link>
            <span>/</span>
            <span>Anotar</span>
          </div>
          <h1 className="text-xl font-bold">
            Cola de Anotación — {deploymentName}
          </h1>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/camera-trap/results/${jobId}`}>Salir de la Cola</Link>
        </Button>
      </div>

      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-muted-foreground">
            {reviewed} de {totalIdentifications} revisadas
          </span>
          <span className="font-medium">{progressPercent.toFixed(0)}%</span>
        </div>
        <Progress value={progressPercent} className="h-2" />
      </div>

      {/* Main content */}
      <div className="grid gap-6 lg:grid-cols-[1fr_350px]">
        <div className="min-w-0">
          <div className="rounded-lg overflow-hidden border bg-muted">
            <BBoxOverlay
              src={imageSrc}
              alt={imageFilename}
              boxes={boxes}
              selectedBoxId={selectedBoxId}
              onBoxClick={(box) =>
                setSelectedBoxId((prev) => (prev === box.id ? null : box.id))
              }
            />
          </div>
          <p className="text-sm text-muted-foreground mt-2 text-center">
            {imageFilename} &middot; Imagen {imageIndex + 1} de {totalImages}
          </p>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Detecciones</CardTitle>
            </CardHeader>
            <CardContent>
              <AnnotationToolbar
                detections={detections}
                speciesList={speciesList}
                selectedDetectionId={selectedBoxId}
                onDetectionSelect={(id) => setSelectedBoxId(id)}
                onActionComplete={handleActionComplete}
                enableKeyboardShortcuts
              />
            </CardContent>
          </Card>

          <Button
            variant="outline"
            className="w-full"
            onClick={handleSkip}
          >
            Saltar (s)
          </Button>

          <Card>
            <CardContent className="pt-4">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Atajos de Teclado
              </p>
              <div className="grid grid-cols-2 gap-1 text-xs">
                <div>
                  <kbd className="px-1 py-0.5 bg-muted rounded font-mono">v</kbd>{" "}
                  Verificar
                </div>
                <div>
                  <kbd className="px-1 py-0.5 bg-muted rounded font-mono">r</kbd>{" "}
                  Rechazar
                </div>
                <div>
                  <kbd className="px-1 py-0.5 bg-muted rounded font-mono">s</kbd>{" "}
                  Saltar
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
