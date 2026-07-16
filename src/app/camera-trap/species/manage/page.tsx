import { requirePermission } from "@/lib/auth";
import { getSpeciesList } from "@/app/camera-trap/actions";
import { ManageSpeciesClient } from "./manage-client";

export default async function ManageSpeciesPage() {
  await requirePermission("camera-trap", "editor");
  // Manage page must see flagged-out (audio-only) species to promote them.
  const speciesList = await getSpeciesList({ includeNonSelectable: true });

  return (
    <div className="max-w-5xl mx-auto">
      <ManageSpeciesClient species={speciesList} />
    </div>
  );
}
