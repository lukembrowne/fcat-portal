import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Camera, Mic, Thermometer, FolderCheck } from "lucide-react";
import type { UploadSummary } from "./actions";

function DeltaText({ delta, value }: { delta: number | null; value: number }) {
  if (delta === null) {
    return (
      <p className="text-xs text-muted-foreground mt-0.5">
        {value.toLocaleString("es")} subidos en total
      </p>
    );
  }
  if (delta > 0) {
    return (
      <p className="text-xs text-emerald-600 mt-0.5">+{delta} desde ayer</p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground mt-0.5">sin cambios desde ayer</p>
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
      icon: Camera,
      color: "text-emerald-600",
    },
    {
      label: "Audio",
      value: summary.audio.toLocaleString("es"),
      rawValue: summary.audio,
      delta: summary.deltaAudio,
      icon: Mic,
      color: "text-violet-600",
    },
    {
      label: "iButton",
      value: summary.ibutton.toLocaleString("es"),
      rawValue: summary.ibutton,
      delta: summary.deltaIbutton,
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
                <DeltaText delta={item.delta} value={item.rawValue} />
              ) : (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {item.subtitle}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
