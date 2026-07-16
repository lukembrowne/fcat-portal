import type { Species } from "@/db/schema";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { IucnCode } from "@/components/iucn-code";

interface SpeciesHeaderProps {
  species: Species;
  totalCount: number;
  siteCount: number;
  backHref: string;
  inlineLinks?: ReactNode;
}

export function SpeciesHeader({
  species,
  totalCount,
  siteCount,
  backHref,
  inlineLinks,
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
        <IucnCode status={species.iucnStatus} className="ml-2 text-xs align-middle" />
      </h1>
      <p className="italic text-muted-foreground">{species.scientificName}</p>
      <p className="text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <span className="font-medium tabular-nums">
            {totalCount.toLocaleString("es-EC")}
          </span>{" "}
          detecciones en{" "}
          <span className="font-medium tabular-nums">{siteCount}</span>{" "}
          {siteCount === 1 ? "sitio" : "sitios"}
        </span>
        {inlineLinks}
      </p>
    </header>
  );
}
