"use client";

import { useRouter } from "next/navigation";
import { BBoxOverlay, type BBoxData } from "@/components/bbox-overlay";
import {
  AnnotationToolbar,
  type DetectionWithIdentification,
} from "@/components/annotation-toolbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useState, useCallback, useRef, useTransition } from "react";
import Link from "next/link";
import { useAnnotationShortcuts } from "@/hooks/use-annotation-shortcuts";
import {
  verifyIdentification,
  rejectIdentification,
  verifyAndAdvance,
  createManualDetection,
} from "@/app/camera-trap/actions";
import type { Species } from "@/db/schema";

interface ImageDetailClientProps {
  src: string;
  alt: string;
  boxes: BBoxData[];
  detections: DetectionWithIdentification[];
  speciesList: Species[];
  jobId: number;
  imageId: number;
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
  imageId,
  prevImageId,
  nextImageId,
}: ImageDetailClientProps) {
  const router = useRouter();
  const [selectedBoxId, setSelectedBoxId] = useState<number | null>(null);
  const [, startTransition] = useTransition();
  const isVerifyingRef = useRef(false);

  const selectedDetection =
    detections.find((d) => d.id === selectedBoxId) || detections[0];

  const handleActionComplete = useCallback(() => {
    router.refresh();
  }, [router]);

  const handleQuickVerifyAll = useCallback(() => {
    if (isVerifyingRef.current) return;

    const unverifiedIds = detections
      .filter((d) => d.identification?.verificationStatus === "unverified")
      .map((d) => d.identification!.id);

    if (unverifiedIds.length === 0) return;

    isVerifyingRef.current = true;
    startTransition(async () => {
      try {
        const result = await verifyAndAdvance(unverifiedIds, jobId, imageId);
        if (result.success && result.data.nextImageId) {
          router.push(
            `/camera-trap/results/${jobId}/images/${result.data.nextImageId}`
          );
        } else if (result.success) {
          router.refresh();
        }
      } finally {
        isVerifyingRef.current = false;
      }
    });
  }, [detections, jobId, imageId, router]);

  const handleVerifySelected = useCallback(() => {
    if (!selectedDetection?.identification) return;
    if (selectedDetection.identification.verificationStatus !== "unverified") return;
    startTransition(async () => {
      await verifyIdentification(selectedDetection.identification!.id);
      router.refresh();
    });
  }, [selectedDetection, router]);

  const handleRejectSelected = useCallback(() => {
    if (!selectedDetection?.identification) return;
    if (selectedDetection.identification.verificationStatus !== "unverified") return;
    startTransition(async () => {
      await rejectIdentification(selectedDetection.identification!.id);
      router.refresh();
    });
  }, [selectedDetection, router]);

  const handleDrawComplete = useCallback(
    (bbox: { x: number; y: number; width: number; height: number }) => {
      startTransition(async () => {
        const result = await createManualDetection(imageId, bbox);
        if (result.success) {
          setSelectedBoxId(result.data.detectionId);
          router.refresh();
        }
      });
    },
    [imageId, router]
  );

  useAnnotationShortcuts({
    enabled: true,
    onVerify: handleVerifySelected,
    onReject: handleRejectSelected,
    onQuickVerifyAll: handleQuickVerifyAll,
    onNext: () => {
      if (nextImageId) {
        router.push(`/camera-trap/results/${jobId}/images/${nextImageId}`);
      }
    },
    onPrev: () => {
      if (prevImageId) {
        router.push(`/camera-trap/results/${jobId}/images/${prevImageId}`);
      }
    },
    onSelectDetection: (index) => {
      if (index < detections.length) {
        setSelectedBoxId(detections[index].id);
      }
    },
    onDeselect: () => setSelectedBoxId(null),
    detectionCount: detections.length,
  });

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
            editable
            onDrawComplete={handleDrawComplete}
          />
        </div>
      </div>

      <div className="space-y-4 min-w-0">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Anotaciones ({detections.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="min-w-0 overflow-hidden">
            <AnnotationToolbar
              detections={detections}
              speciesList={speciesList}
              selectedDetectionId={selectedBoxId}
              onDetectionSelect={(id) => setSelectedBoxId(id)}
              onActionComplete={handleActionComplete}
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
