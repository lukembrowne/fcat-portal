import { Badge } from "@/components/ui/badge";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const JOB_STATUS_CONFIG: Record<
  string,
  { variant: BadgeVariant; label: string; className?: string }
> = {
  pending: { variant: "secondary", label: "Pendiente" },
  processing: { variant: "default", label: "Procesando" },
  completed: { variant: "default", label: "Completado", className: "bg-green-600" },
  failed: { variant: "destructive", label: "Fallido" },
  cancelled: { variant: "outline", label: "Cancelado" },
};

const DEPLOYMENT_STATUS_CONFIG: Record<
  string,
  { variant: BadgeVariant; label: string; className?: string }
> = {
  unscanned: { variant: "secondary", label: "Por Procesar", className: "bg-blue-100 text-blue-700" },
  scanned: { variant: "secondary", label: "Por Procesar", className: "bg-blue-100 text-blue-700" },
  processing: { variant: "default", label: "Procesando", className: "bg-yellow-500" },
  processed: { variant: "default", label: "Por Revisar", className: "bg-orange-500" },
  processed_empty: { variant: "secondary", label: "Sin Detecciones", className: "bg-gray-100 text-gray-600" },
  verified: { variant: "default", label: "Verificada", className: "bg-emerald-700" },
  verified_empty: { variant: "default", label: "Vacía (verificada)", className: "bg-slate-500" },
  no_data: { variant: "secondary", label: "Sin datos", className: "bg-slate-200 text-slate-700" },
};

const AUDIO_DEPLOYMENT_STATUS_CONFIG: Record<
  string,
  { variant: BadgeVariant; label: string; className?: string }
> = {
  unscanned: { variant: "secondary", label: "Sin escanear", className: "bg-gray-100 text-gray-600" },
  scanned: { variant: "secondary", label: "Escaneado", className: "bg-blue-100 text-blue-700" },
  birdnet_processing: { variant: "default", label: "Procesando BirdNET", className: "bg-yellow-500" },
  analyzed: { variant: "default", label: "Por Revisar", className: "bg-orange-500" },
  reviewed: { variant: "default", label: "Revisado", className: "bg-emerald-700" },
};

const IMAGE_STATUS_CONFIG: Record<
  string,
  { variant: BadgeVariant; label: string; className?: string }
> = {
  pending: { variant: "secondary", label: "Pendiente" },
  processed: { variant: "secondary", label: "Procesada", className: "bg-green-100 text-green-700" },
  failed: { variant: "destructive", label: "Fallida" },
};

type StatusType = "job" | "deployment" | "image" | "audio-deployment";

const CONFIG_MAP: Record<StatusType, Record<string, { variant: BadgeVariant; label: string; className?: string }>> = {
  job: JOB_STATUS_CONFIG,
  deployment: DEPLOYMENT_STATUS_CONFIG,
  image: IMAGE_STATUS_CONFIG,
  "audio-deployment": AUDIO_DEPLOYMENT_STATUS_CONFIG,
};

export function StatusBadge({
  status,
  type = "job",
}: {
  status: string;
  type?: StatusType;
}) {
  const config = CONFIG_MAP[type];
  const entry = config[status] || { variant: "secondary" as BadgeVariant, label: status };

  return (
    <Badge variant={entry.variant} className={entry.className}>
      {entry.label}
    </Badge>
  );
}
