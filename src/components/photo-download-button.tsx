"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PhotoDownloadButtonProps {
  photoUrl: string;
  filename?: string;
}

export function PhotoDownloadButton({ photoUrl, filename }: PhotoDownloadButtonProps) {
  const downloadUrl = photoUrl + (photoUrl.includes("?") ? "&" : "?") + "download=true";

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="absolute bottom-2 right-2 bg-black/40 text-white hover:bg-black/70 hover:text-white"
      asChild
    >
      <a
        href={downloadUrl}
        download={filename ?? true}
        onClick={(e) => e.stopPropagation()}
      >
        <Download />
      </a>
    </Button>
  );
}
