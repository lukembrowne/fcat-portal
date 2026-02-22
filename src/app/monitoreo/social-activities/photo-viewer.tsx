"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SocialActivityRecord } from "@/lib/odk-types";
import { PhotoDownloadButton } from "@/components/photo-download-button";

interface PhotoViewerProps {
  activity: SocialActivityRecord | null;
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
      <div className="flex items-center justify-center h-48 bg-muted rounded-md">
        <p className="text-xs text-muted-foreground">Sin {label}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-48 bg-muted rounded-md">
        <p className="text-xs text-muted-foreground">Error cargando {label}</p>
      </div>
    );
  }

  const url = `/api/odk/photos?projectId=11&formId=actividades_sociales_fcat&id=${encodeURIComponent(instanceId)}&file=${encodeURIComponent(filename)}`;

  return (
    <div className="space-y-1">
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={label}
          className="w-full h-48 object-cover rounded-md"
          onError={() => setError(true)}
        />
        <PhotoDownloadButton photoUrl={url} filename={filename} />
      </div>
      <p className="text-xs text-center text-muted-foreground">{label}</p>
    </div>
  );
}

export function PhotoViewer({ activity, open, onOpenChange }: PhotoViewerProps) {
  if (!activity) return null;

  const registrationPhotos = [
    { filename: activity.fotoListaParticipantes, label: "Lista de participantes" },
    { filename: activity.fotoRegistro2, label: "Registro adicional" },
  ].filter((p) => p.filename);

  const eventPhotos = [
    { filename: activity.fotoEvento1, label: "Foto del evento 1" },
    { filename: activity.fotoEvento2, label: "Foto del evento 2" },
    { filename: activity.fotoEvento3, label: "Foto del evento 3" },
    { filename: activity.fotoEvento4, label: "Foto del evento 4" },
  ].filter((p) => p.filename);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{activity.temaEvento || "Actividad"}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {activity.fecha ?? "Sin fecha"} | {activity.tipoEventoLabel} |{" "}
            {activity.lugarEventoLabel}
          </p>
        </DialogHeader>

        {registrationPhotos.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Registro de Participantes</h3>
            <div className="grid grid-cols-2 gap-3">
              {registrationPhotos.map((p) => (
                <PhotoImage
                  key={p.label}
                  instanceId={activity.id}
                  filename={p.filename}
                  label={p.label}
                />
              ))}
            </div>
          </div>
        )}

        {eventPhotos.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Fotos del Evento</h3>
            <div className="grid grid-cols-2 gap-3">
              {eventPhotos.map((p) => (
                <PhotoImage
                  key={p.label}
                  instanceId={activity.id}
                  filename={p.filename}
                  label={p.label}
                />
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
