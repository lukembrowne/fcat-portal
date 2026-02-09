"use client";

import { Button } from "@/components/ui/button";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <h1 className="text-2xl font-bold">Algo salió mal</h1>
      <p className="text-muted-foreground">
        Ocurrió un error inesperado. Intenta de nuevo.
      </p>
      <Button onClick={() => reset()}>Intentar de nuevo</Button>
    </div>
  );
}
