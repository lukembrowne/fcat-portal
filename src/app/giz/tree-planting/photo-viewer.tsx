"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TreeRecord } from "@/lib/odk-types";
import { PhotoDownloadButton } from "@/components/photo-download-button";

interface PhotoViewerProps {
  tree: TreeRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function PhotoImage({
  instanceId,
  filename,
  label,
}: {
  instanceId: string;
  filename: string | null;
  label: string;
}) {
  const [error, setError] = useState(false);

  if (!filename) {
    return (
      <div className="flex items-center justify-center h-72 bg-muted rounded-md">
        <p className="text-xs text-muted-foreground">Sin {label}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-72 bg-muted rounded-md">
        <p className="text-xs text-muted-foreground">Error cargando {label}</p>
      </div>
    );
  }

  const url = `/api/odk/photos?projectId=2&formId=siembra_arboles&id=${encodeURIComponent(instanceId)}&file=${encodeURIComponent(filename)}`;

  return (
    <div className="space-y-1">
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={label}
          className="w-full h-72 object-cover rounded-md"
          onError={() => setError(true)}
        />
        {!error && <PhotoDownloadButton photoUrl={url} filename={filename} />}
      </div>
      <p className="text-xs text-center text-muted-foreground">{label}</p>
    </div>
  );
}

export function PhotoViewer({ tree, open, onOpenChange }: PhotoViewerProps) {
  if (!tree) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {tree.code} — {tree.species}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Finca: {tree.farm} | Dueño: {tree.owner} | Fecha: {tree.date ?? "N/A"}
          </p>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          <PhotoImage
            instanceId={tree.id}
            filename={tree.photoTop}
            label="Vista superior"
          />
          <PhotoImage
            instanceId={tree.id}
            filename={tree.photoSide}
            label="Vista lateral"
          />
          <PhotoImage
            instanceId={tree.id}
            filename={tree.photoLeaf}
            label="Hoja"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
