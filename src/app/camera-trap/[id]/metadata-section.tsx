"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Pencil } from "lucide-react";
import { DeploymentEditForm } from "../deployment-edit-form";
import type { DeploymentRow } from "../actions";

interface MetadataSectionProps {
  deployment: {
    id: number;
    name: string;
    cameraTrapProjectId: number | null;
    siteName: string | null;
    latitude: number | null;
    longitude: number | null;
    dateStart: string | null;
    dateEnd: string | null;
    totalImages: number | null;
    totalVideos: number | null;
    metadataSource: string | null;
  };
  distinctProjects: { id: number; name: string }[];
  canEdit: boolean;
}

export function MetadataSection({
  deployment,
  distinctProjects,
  canEdit,
}: MetadataSectionProps) {
  const [editing, setEditing] = useState(false);
  const router = useRouter();

  if (editing) {
    return (
      <div className="max-w-md">
        <DeploymentEditForm
          deployment={deployment as unknown as DeploymentRow}
          distinctProjects={distinctProjects}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      </div>
    );
  }

  const metadataSourceLabel =
    deployment.metadataSource === "odk"
      ? "ODK"
      : deployment.metadataSource === "drive"
        ? "Drive"
        : deployment.metadataSource === "manual"
          ? "Manual"
          : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <MetaField label="Sitio" value={deployment.siteName} />
        <MetaField
          label="Ubicación"
          value={
            deployment.latitude && deployment.longitude
              ? `${deployment.latitude.toFixed(5)}, ${deployment.longitude.toFixed(5)}`
              : null
          }
        />
        <MetaField label="Fecha inicio" value={deployment.dateStart} />
        <MetaField label="Fecha fin" value={deployment.dateEnd} />
        <MetaField
          label="Imágenes"
          value={
            deployment.totalImages != null && deployment.totalImages > 0
              ? deployment.totalImages.toLocaleString()
              : null
          }
        />
        <MetaField
          label="Videos"
          value={
            deployment.totalVideos != null && deployment.totalVideos > 0
              ? deployment.totalVideos.toLocaleString()
              : null
          }
        />
        {metadataSourceLabel && (
          <MetaField label="Fuente" value={metadataSourceLabel} />
        )}
      </div>
      {canEdit && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
        >
          <Pencil className="h-3.5 w-3.5 mr-1.5" />
          Editar Metadatos
        </Button>
      )}
    </div>
  );
}

function MetaField({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value ?? "—"}</p>
    </div>
  );
}
