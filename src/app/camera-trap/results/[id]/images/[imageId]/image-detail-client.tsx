"use client";

import { useRouter } from "next/navigation";
import { BBoxOverlay, type BBoxData } from "@/components/bbox-overlay";
import {
  AnnotationToolbar,
  type DetectionWithIdentification,
} from "@/components/annotation-toolbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface ImageDetailClientProps {
  src: string;
  alt: string;
  boxes: BBoxData[];
  detections: DetectionWithIdentification[];
  speciesList: string[];
  jobId: number;
  prevImageId: number | null;
  nextImageId: number | null;
}

export function ImageDetailClient({
  src,
  alt,
  boxes,
  detections,
  speciesList,
  jobId,
  prevImageId,
  nextImageId,
}: ImageDetailClientProps) {
  const router = useRouter();
  const [selectedBoxId, setSelectedBoxId] = useState<number | null>(null);

  const handleActionComplete = useCallback(() => {
    router.refresh();
  }, [router]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (e.key === "ArrowLeft" && prevImageId) {
        e.preventDefault();
        router.push(`/camera-trap/results/${jobId}/images/${prevImageId}`);
      } else if (e.key === "ArrowRight" && nextImageId) {
        e.preventDefault();
        router.push(`/camera-trap/results/${jobId}/images/${nextImageId}`);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router, jobId, prevImageId, nextImageId]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0">
        <div className="rounded-lg overflow-hidden border bg-muted">
          <BBoxOverlay
            src={src}
            alt={alt}
            boxes={boxes}
            selectedBoxId={selectedBoxId}
            onBoxClick={(box) =>
              setSelectedBoxId((prev) => (prev === box.id ? null : box.id))
            }
          />
        </div>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Anotaciones ({detections.length})
            </CardTitle>
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

        <Button asChild variant="outline" className="w-full">
          <Link href={`/camera-trap/results/${jobId}`}>
            Volver a la Cuadrícula
          </Link>
        </Button>
      </div>
    </div>
  );
}
