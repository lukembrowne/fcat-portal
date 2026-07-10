"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { clearLilaImages, getLilaCacheStats } from "./lila-actions";

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function LilaCacheControls() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [freed, setFreed] = useState<number | null>(null);
  // null = still loading the size (the walk can take a few seconds on the droplet).
  const [stats, setStats] = useState<{ bytes: number; fileCount: number } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    getLilaCacheStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        if (!cancelled) setStats({ bytes: 0, fileCount: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleClear() {
    setError(null);
    setFreed(null);
    startTransition(async () => {
      const res = await clearLilaImages();
      if (res.success) {
        setFreed(res.freedBytes);
        setStats({ bytes: 0, fileCount: 0 });
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  const loading = stats === null;
  const empty = !loading && stats.fileCount === 0;

  return (
    <div className="rounded-lg border p-4">
      <h3 className="font-medium">Imágenes en disco</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Las imágenes LILA descargadas son una <strong>caché regenerable</strong>:
        ocupan espacio en el servidor pero se pueden borrar para liberarlo. El
        próximo exporte las vuelve a descargar automáticamente desde LILA (más
        lento, requiere que LILA esté en línea). Los datos en la base (cajas,
        etiquetas, procedencia) no se borran.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-sm tabular-nums">
          {loading ? (
            <span className="text-muted-foreground">Calculando tamaño…</span>
          ) : empty ? (
            <span className="text-muted-foreground">Sin imágenes en caché.</span>
          ) : (
            <>
              <strong>{formatBytes(stats.bytes)}</strong> en{" "}
              {stats.fileCount.toLocaleString("es-EC")} archivos
            </>
          )}
        </span>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={isPending || loading || empty}
          onClick={handleClear}
        >
          {isPending ? "Borrando…" : "Borrar imágenes LILA"}
        </Button>
        {freed !== null && (
          <span className="text-sm text-muted-foreground">
            Se liberaron {formatBytes(freed)}.
          </span>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </div>
  );
}
