"use client";

import { Button } from "@/components/ui/button";
import { Download, X } from "lucide-react";
import type { AudioFileRow } from "../actions";
import { formatBytes } from "@/lib/format";

export function AudioPlayer({
  fileId,
  file,
  onClose,
}: {
  fileId: string;
  file: AudioFileRow | null;
  onClose: () => void;
}) {
  const streamUrl = `/api/audio/stream?fileId=${encodeURIComponent(fileId)}`;

  return (
    <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="font-medium">{file?.filename ?? "Audio"}</span>
          {file?.fileSize && (
            <span className="text-muted-foreground ml-2">
              {formatBytes(file.fileSize)}
            </span>
          )}
          {file?.format && (
            <span className="text-muted-foreground ml-2 uppercase">
              {file.format}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <a href={`${streamUrl}&download=true`} download>
            <Button size="sm" variant="ghost">
              <Download className="h-4 w-4" />
            </Button>
          </a>
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <audio
        controls
        preload="none"
        className="w-full"
        src={streamUrl}
      />
    </div>
  );
}
