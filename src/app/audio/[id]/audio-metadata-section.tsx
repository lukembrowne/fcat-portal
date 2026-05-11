interface AudioMetadataSectionProps {
  deployment: {
    siteName: string | null;
    latitude: number | null;
    longitude: number | null;
    dateStart: string | null;
    dateEnd: string | null;
    ctProjectName: string | null;
  };
  fileCount: number;
}

export function AudioMetadataSection({
  deployment,
  fileCount,
}: AudioMetadataSectionProps) {
  return (
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
        label="Grabaciones"
        value={fileCount > 0 ? fileCount.toLocaleString() : null}
      />
      <MetaField label="Proyecto" value={deployment.ctProjectName} />
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
