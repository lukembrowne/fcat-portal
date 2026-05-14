import { requirePermission } from "@/lib/auth";
import { getSpeciesList } from "@/app/camera-trap/actions";
import { ManageSpeciesClient } from "./manage-client";

export default async function ManageSpeciesPage() {
  await requirePermission("camera-trap", "editor");
  const speciesList = await getSpeciesList();

  return (
    <div className="max-w-5xl mx-auto">
      <ManageSpeciesClient species={speciesList} />
    </div>
  );
}
