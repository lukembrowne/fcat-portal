import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getStarredImages } from "@/app/camera-trap/actions";
import { Badge } from "@/components/ui/badge";

export default async function FavoritesPage() {
  await requirePermission("camera-trap", "viewer");

  const starredImages = await getStarredImages();

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
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {starredImages.map((image) => (
            <FavoriteCard key={image.id} image={image} />
          ))}
        </div>
      )}
    </div>
  );
}

function FavoriteCard({
  image,
}: {
  image: Awaited<ReturnType<typeof getStarredImages>>[number];
}) {
  const thumbUrl = `/api/ct-images/${image.id}?size=thumb`;
  const hasJob = image.jobId != null;
  const href = hasJob
    ? `/camera-trap/results/${image.jobId}/images/${image.id}`
    : undefined;

  const inner = (
    <div className="group relative aspect-[4/3] rounded-lg overflow-hidden border bg-muted cursor-pointer hover:ring-2 hover:ring-primary transition-all">
      <img
        src={thumbUrl}
        alt={image.filename}
        className="w-full h-full object-cover"
        loading="lazy"
      />

      {/* Star badge */}
      <div className="absolute top-2 left-2 z-10">
        <svg
          className="size-5 text-amber-400 drop-shadow"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
        </svg>
      </div>

      {/* Deployment info overlay */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 pt-6">
        <p className="text-white text-xs font-medium truncate">
          {image.deploymentName}
        </p>
        {image.siteName && (
          <p className="text-white/70 text-[10px] truncate">{image.siteName}</p>
        )}
      </div>

      {/* Attribution on hover */}
      <div className="absolute top-0 right-0 left-6 bg-gradient-to-b from-black/50 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <p className="text-white text-[10px] truncate text-right">
          {image.starredBy}
          {image.starredAt && (
            <> · {new Date(image.starredAt).toLocaleDateString("es-EC")}</>
          )}
        </p>
      </div>

      {!hasJob && (
        <div className="absolute top-2 right-2">
          <Badge variant="outline" className="bg-white/80 text-[10px]">
            Sin trabajo
          </Badge>
        </div>
      )}
    </div>
  );

  if (href) {
    return <Link href={href}>{inner}</Link>;
  }

  return (
    <div title="El trabajo de procesamiento fue eliminado">{inner}</div>
  );
}
