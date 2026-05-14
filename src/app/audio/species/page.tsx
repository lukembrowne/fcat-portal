import { requirePermission } from "@/lib/auth";
import { getAudioSpeciesIndex } from "./actions";
import { SpeciesIndexTable } from "@/components/species/species-index-table";
import { ConfidenceThresholdSlider } from "@/components/audio/confidence-threshold-slider";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AudioSpeciesIndexPage({ searchParams }: PageProps) {
  await requirePermission("grabaciones", "viewer");
  const params = await searchParams;
  const result = await getAudioSpeciesIndex(params);

  if (!result.success) {
    return (
      <div className="max-w-5xl mx-auto p-4">
        <p className="text-destructive">{result.error}</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Explorar por especie</h1>
        <p className="text-sm text-muted-foreground">
          Detecciones de BirdNET, agregadas por especie sobre todas las
          grabaciones de los proyectos a los que tienes acceso.
        </p>
      </header>

      <div className="flex justify-end">
        <div className="min-w-[260px] max-w-md flex-1">
          <ConfidenceThresholdSlider variant="compact" />
        </div>
      </div>

      <SpeciesIndexTable rows={result.data} basePath="/audio/species" />
    </div>
  );
}
