import { requirePermission } from "@/lib/auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Sheet,
  Presentation,
  ClipboardList,
  ExternalLink,
} from "lucide-react";

const resources = [
  {
    icon: Sheet,
    name: "Cronograma en Google Sheets",
    description: "Calendario de instalaciones y recuperaciones",
    url: `https://docs.google.com/spreadsheets/d/${process.env.BIOCHOCO_SHEET_ID}`,
    requiresEnv: true,
  },
  {
    icon: Presentation,
    name: "Presentación de Lanzamiento",
    description: "Presentación del inicio del proyecto BIOCHOCO",
    url: "https://docs.google.com/presentation/d/1qtIJT6bAgM94z7ztTsarMCRXbcP9it4q",
    requiresEnv: false,
  },
  {
    icon: ClipboardList,
    name: "Protocolos de Sensores",
    description: "Protocolos de preparación e instalación de sensores",
    url: "https://docs.google.com/document/d/15rsETlhLb5i39OsSTY_blrl3D7Q4bZK_TXhlIlo9Yt8/edit",
    requiresEnv: false,
  },
];

export default async function RecursosPage() {
  await requirePermission("biochoco", "viewer");

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-2">Recursos</h1>
      <p className="text-muted-foreground mb-6">
        Enlaces y documentos del proyecto BIOCHOCO
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {resources
          .filter((r) => !r.requiresEnv || process.env.BIOCHOCO_SHEET_ID)
          .map((resource) => (
            <a
              key={resource.name}
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group"
            >
              <Card className="h-full transition-colors group-hover:border-primary/50">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <resource.icon className="size-5 text-muted-foreground group-hover:text-primary transition-colors" />
                    <CardTitle className="text-base">{resource.name}</CardTitle>
                  </div>
                  <CardDescription>{resource.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <span className="inline-flex items-center gap-1.5 text-sm text-primary font-medium">
                    Abrir <ExternalLink className="size-3.5" />
                  </span>
                </CardContent>
              </Card>
            </a>
          ))}
      </div>
    </div>
  );
}
