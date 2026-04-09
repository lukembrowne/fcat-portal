import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getStarredImages } from "@/app/camera-trap/actions";
import { FavoritesClient } from "./favorites-client";

export default async function FavoritesPage() {
  await requirePermission("camera-trap", "viewer");

  const { images: starredImages, speciesList } = await getStarredImages();

  return (
    <div className="max-w-7xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link href="/camera-trap" className="hover:underline">
          Cámaras Trampa
        </Link>
        <span>/</span>
        <span>Destacadas</span>
      </div>

      <h1 className="text-3xl font-bold mb-2">Imágenes Destacadas</h1>
      <p className="text-sm text-muted-foreground mb-6">
        {starredImages.length > 0
          ? `${starredImages.length} ${starredImages.length === 1 ? "imagen destacada" : "imágenes destacadas"} en total`
          : "No hay imágenes destacadas. Marca tus fotos favoritas desde la vista de anotación."}
      </p>

      {starredImages.length > 0 && (
        <FavoritesClient images={starredImages} speciesList={speciesList} />
      )}
    </div>
  );
}
