import { requirePermission } from "@/lib/auth";
import { fetchSpeciesContentList } from "./actions";
import { FichasEspeciesClient } from "./fichas-client";

/**
 * "Fichas de especies" — authors the shared per-species content (ecological
 * role + management tip) that appears on every public finca page. Global
 * content: one edit propagates to all sites showing that species.
 */
export default async function FichasEspeciesPage() {
  await requirePermission("biochoco", "editor");
  const speciesList = await fetchSpeciesContentList();

  return (
    <div className="max-w-5xl mx-auto">
      <FichasEspeciesClient species={speciesList} />
    </div>
  );
}
