"use client";

import { useState, useTransition } from "react";
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
  const [isPending, startTransition] = useTransition();
  const [link, setLink] = useState<string | null>(webViewLink);
  const [error, setError] = useState<string | null>(null);

  function handleUpload() {
    setError(null);
    startTransition(async () => {
      const res = await packageAndUploadExport(version);
      if (res.success) {
        setLink(res.data.webViewLink);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {link ? (
          <a
            href={link}
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
          variant={link ? "ghost" : "secondary"}
          size="sm"
          onClick={handleUpload}
          disabled={isPending}
        >
          {isPending
            ? "Empaquetando…"
            : link
              ? "Volver a subir"
              : "Empaquetar y subir a Drive"}
        </Button>
      </div>

      {isPending && (
        <p className="text-[11px] text-muted-foreground">
          Puede tardar varios minutos para exportes grandes.
        </p>
      )}

      {link && uploadedAt && !isPending && (
        <p className="text-[11px] text-muted-foreground">
          Subido {uploadedAt}
        </p>
      )}

      {error && (
        <p className="text-[11px] text-destructive">{error}</p>
      )}

      <details className="text-[11px]">
        <summary className="cursor-pointer text-muted-foreground select-none">
          Instrucciones CLI
        </summary>
        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono">
{`docker compose exec portal tar -czf - -C data/training-exports ${version} > ${version}.tar.gz
# luego scp / rsync ${version}.tar.gz desde el host`}
        </pre>
      </details>
    </div>
  );
}
