import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Camera, Mic, Thermometer, FolderCheck } from "lucide-react";
import type { UploadSummary } from "./actions";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function DeltaText({
  delta,
  value,
  previousSnapshotDate,
}: {
  delta: number | null;
  value: number;
  previousSnapshotDate: string | null;
}) {
  if (delta === null) {
    return (
      <p className="text-xs text-muted-foreground mt-0.5">
        {value.toLocaleString("es")} subidos en total
      </p>
    );
  }
  const sinceLabel = previousSnapshotDate
    ? `desde ${previousSnapshotDate}`
    : "desde último conteo";
  if (delta > 0) {
    return (
      <p className="text-xs text-emerald-600 mt-0.5">+{delta} {sinceLabel}</p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground mt-0.5">sin cambios {sinceLabel}</p>
  );
}

export function UploadSummaryCards({
  summary,
  retrievedWithUploads,
  totalRetrieved,
}: {
  summary: UploadSummary;
  retrievedWithUploads: number;
  totalRetrieved: number;
}) {
  const totalSizeBytes = summary.cameraSizeBytes + summary.audioSizeBytes + summary.ibuttonSizeBytes;

  const items = [
    {
      label: "Instalaciones",
      value: `${retrievedWithUploads} / ${totalRetrieved}`,
      subtitle: "recuperadas con archivos subidos",
      icon: FolderCheck,
      color: "text-blue-600",
    },
    {
      label: "Camaras",
      value: summary.cameras.toLocaleString("es"),
      rawValue: summary.cameras,
      delta: summary.deltaCameras,
      sizeBytes: summary.cameraSizeBytes,
      icon: Camera,
      color: "text-emerald-600",
    },
    {
      label: "Audio",
      value: summary.audio.toLocaleString("es"),
      rawValue: summary.audio,
      delta: summary.deltaAudio,
      sizeBytes: summary.audioSizeBytes,
      icon: Mic,
      color: "text-violet-600",
    },
    {
      label: "iButton",
      value: summary.ibutton.toLocaleString("es"),
      rawValue: summary.ibutton,
      delta: summary.deltaIbutton,
      sizeBytes: summary.ibuttonSizeBytes,
      icon: Thermometer,
      color: "text-orange-600",
    },
  ] as const;

  return (
    <div className="container mx-auto px-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {items.map((item) => (
          <Card key={item.label} className="py-4">
            <CardHeader className="flex flex-row items-center justify-between pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {item.label}
              </CardTitle>
              <item.icon className={`h-4 w-4 ${item.color}`} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{item.value}</div>
              {"delta" in item ? (
                <>
                  {"sizeBytes" in item && item.sizeBytes > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(item.sizeBytes)}
                    </p>
                  )}
                  <DeltaText
                    delta={item.delta}
                    value={item.rawValue}
                    previousSnapshotDate={summary.previousSnapshotDate}
                  />
                </>
              ) : (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {item.subtitle}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {totalSizeBytes > 0 && (
        <p className="text-sm text-muted-foreground text-center mt-2">
          Total: {formatBytes(totalSizeBytes)} en{" "}
          {(summary.cameras + summary.audio + summary.ibutton).toLocaleString("es")} archivos
        </p>
      )}
    </div>
  );
}
