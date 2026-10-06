import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Download link for the correct-detections CSV (`/api/audio/validation-export`).
 * A plain anchor: the route streams the file with Content-Disposition, so no
 * client code is needed. Without `species` it exports every species the reader
 * may see; species still blind to them are named in the file's header.
 */
export function ExportCorrectLink({
  species,
  label,
}: {
  species?: string;
  label: string;
}) {
  const href = species
    ? `/api/audio/validation-export?species=${encodeURIComponent(species)}`
    : "/api/audio/validation-export";
  return (
    <Button asChild variant="outline" size="sm">
      <a
        href={href}
        download
        title="CSV con fecha y hora local, sitio, coordenadas y hábitat de cada clip confirmado como correcto"
      >
        <Download className="mr-1.5 h-4 w-4" aria-hidden />
        {label}
      </a>
    </Button>
  );
}
