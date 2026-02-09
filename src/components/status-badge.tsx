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
  unscanned: { variant: "outline", label: "Sin escanear" },
  scanned: { variant: "secondary", label: "Escaneado" },
  processing: { variant: "default", label: "Procesando" },
  processed: { variant: "default", label: "Procesado", className: "bg-green-600" },
  verified: { variant: "default", label: "Verificado", className: "bg-emerald-700" },
};

const IMAGE_STATUS_CONFIG: Record<
  string,
  { variant: BadgeVariant; label: string; className?: string }
> = {
  pending: { variant: "secondary", label: "Pendiente" },
  processed: { variant: "secondary", label: "Procesada", className: "bg-green-100 text-green-700" },
  failed: { variant: "destructive", label: "Fallida" },
};

type StatusType = "job" | "deployment" | "image";

const CONFIG_MAP: Record<StatusType, Record<string, { variant: BadgeVariant; label: string; className?: string }>> = {
  job: JOB_STATUS_CONFIG,
  deployment: DEPLOYMENT_STATUS_CONFIG,
  image: IMAGE_STATUS_CONFIG,
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
