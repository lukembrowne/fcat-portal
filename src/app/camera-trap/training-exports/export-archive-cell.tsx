"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { packageAndUploadExport } from "./actions";

export function ExportArchiveCell({
  version,
  webViewLink,
  uploadedAt,
}: {
  version: string;
  webViewLink: string | null;
  /** ISO string or localized date — rendered as-is. */
  uploadedAt: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The upload runs as a background job; when any job terminates the floating
  // bar dispatches `jobs-updated`. Refresh so the server-rendered link/date for
  // this row re-seed once the upload completes.
  useEffect(() => {
    const onUpdated = () => {
      router.refresh();
      setStarted(false);
    };
    window.addEventListener("jobs-updated", onUpdated);
    return () => window.removeEventListener("jobs-updated", onUpdated);
  }, [router]);

  function handleUpload() {
    setError(null);
    startTransition(async () => {
      const res = await packageAndUploadExport(version);
      if (res.success) {
        setStarted(true);
        // Wake the floating bar so it picks up the upload job immediately.
        window.dispatchEvent(new Event("job-started"));
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {webViewLink ? (
          <a
            href={webViewLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Abrir en Drive
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
        <Button
          type="button"
          variant={webViewLink ? "ghost" : "secondary"}
          size="sm"
          onClick={handleUpload}
          disabled={isPending || started}
        >
          {isPending
            ? "Iniciando…"
            : webViewLink
              ? "Volver a subir"
              : "Empaquetar y subir a Drive"}
        </Button>
      </div>

      {started && (
        <p className="text-[11px] text-muted-foreground">
          Subida iniciada — sigue el progreso en la barra inferior.
        </p>
      )}

      {webViewLink && uploadedAt && !started && (
        <p className="text-[11px] text-muted-foreground">Subido {uploadedAt}</p>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
