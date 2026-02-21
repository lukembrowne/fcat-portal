"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useState, useTransition, useCallback, Suspense } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ProgressTracker } from "@/components/progress-tracker";
import { QueueOverview } from "@/components/queue-overview";
import { useActiveJobs } from "@/hooks/use-active-jobs";
import { cancelJob } from "../actions";

function ProcessingContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const jobId = searchParams.get("jobId");
  const [isPending, startTransition] = useTransition();
  const [cancelled, setCancelled] = useState(false);

  const { allJobs, pendingJobs } = useActiveJobs();

  const handleComplete = useCallback(() => {
    // If there are pending jobs in the queue, navigate to the next one
    // (the next pending job will become the processing job shortly)
    setTimeout(() => {
      if (pendingJobs.length > 0) {
        const nextJob = pendingJobs[0];
        window.dispatchEvent(new Event("jobs-updated"));
        router.push(`/camera-trap/process?jobId=${nextJob.jobId}`);
      } else {
        router.push(`/camera-trap/results/${jobId}`);
      }
    }, 1500);
  }, [pendingJobs, jobId, router]);

  if (!jobId) {
    return (
      <div className="max-w-2xl mx-auto">
        <Card>
          <CardContent className="py-12 text-center">
            <h3 className="text-lg font-medium mb-2">Sin trabajo seleccionado</h3>
            <p className="text-muted-foreground mb-4">
              Inicia un nuevo trabajo desde la página de Cámaras Trampa.
            </p>
            <Button asChild>
              <Link href="/camera-trap">Ir a Cámaras Trampa</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const jobIdNum = parseInt(jobId, 10);

  const handleCancel = () => {
    startTransition(async () => {
      const result = await cancelJob(jobIdNum);
      if (result.success) {
        setCancelled(true);
      } else {
        alert(`Error al cancelar: ${result.error}`);
      }
    });
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href="/camera-trap" className="hover:underline">
            Cámaras Trampa
          </Link>
          <span>/</span>
          <span>Procesando</span>
        </div>
        <h1 className="text-3xl font-bold mb-2">Procesando Imágenes</h1>
        <p className="text-muted-foreground">Trabajo #{jobId}</p>
      </div>

      <QueueOverview currentJobId={jobIdNum} />

      <ProgressTracker
        jobId={jobIdNum}
        onComplete={handleComplete}
        onCancel={handleCancel}
      />

      {cancelled && (
        <Card className="mt-4">
          <CardContent className="py-6 text-center">
            <p className="text-orange-600 mb-4">Procesamiento cancelado.</p>
            <div className="flex gap-2 justify-center">
              <Button asChild variant="outline">
                <Link href="/camera-trap">Nuevo Trabajo</Link>
              </Button>
              <Button asChild>
                <Link href={`/camera-trap/results/${jobId}`}>
                  Ver Resultados Parciales
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mt-8 flex gap-4">
        <Button asChild variant="outline">
          <Link href="/camera-trap">Volver a Cámaras Trampa</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/camera-trap/results">Todos los Resultados</Link>
        </Button>
      </div>
    </div>
  );
}

export default function ProcessPage() {
  return (
    <Suspense fallback={<ProcessingPageSkeleton />}>
      <ProcessingContent />
    </Suspense>
  );
}

function ProcessingPageSkeleton() {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <div className="h-4 w-32 bg-muted rounded mb-2" />
        <div className="h-8 w-64 bg-muted rounded mb-2" />
        <div className="h-4 w-24 bg-muted rounded" />
      </div>
      <Card>
        <CardContent className="py-6">
          <div className="h-4 w-full bg-muted rounded mb-4" />
          <div className="h-4 w-full bg-muted rounded" />
        </CardContent>
      </Card>
    </div>
  );
}
