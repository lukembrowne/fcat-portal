import { requirePermission } from "@/lib/auth";
import { getSpeciesList } from "@/app/camera-trap/actions";
import { SpeciesClient } from "./species-client";

export default async function SpeciesPage() {
  await requirePermission("camera-trap", "editor");
  const speciesList = await getSpeciesList();

  return (
    <div className="max-w-5xl mx-auto">
      <SpeciesClient species={speciesList} />
    </div>
  );
}
