import type { Species } from "@/db/schema";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

interface SpeciesHeaderProps {
  species: Species;
  totalCount: number;
  siteCount: number;
  backHref: string;
}

export function SpeciesHeader({
  species,
  totalCount,
  siteCount,
  backHref,
}: SpeciesHeaderProps) {
  return (
    <header className="space-y-2">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-3 h-3" /> Volver a especies
      </Link>
      <h1 className="text-2xl font-semibold">
        {species.commonName}
        {species.spanishName ? (
          <span className="text-base font-normal text-muted-foreground ml-2">
            · {species.spanishName}
          </span>
        ) : null}
      </h1>
      <p className="italic text-muted-foreground">{species.scientificName}</p>
      <p className="text-sm">
        <span className="font-medium tabular-nums">
          {totalCount.toLocaleString("es-EC")}
        </span>{" "}
        detecciones en{" "}
        <span className="font-medium tabular-nums">{siteCount}</span>{" "}
        {siteCount === 1 ? "sitio" : "sitios"}
      </p>
    </header>
  );
}
