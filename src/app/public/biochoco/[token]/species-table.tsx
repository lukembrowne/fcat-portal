import type { SiteSpecies } from "@/app/biochoco/resultados/types";
import { iucnChip } from "@/lib/landowner/iucn-chip";
import {
  sortSpeciesForTable,
  speciesCommonName,
} from "@/lib/landowner/copy";
import { Bird, PawPrint, ListTree } from "lucide-react";

interface SpeciesTableProps {
  species: SiteSpecies[];
  /** Token-gated thumbnail URL builder (same as the carousel uses). */
  resolveImageUrl: (id: number, size: "thumb" | "large") => string;
  /** Link to a species' photo gallery; rows with photos become tappable. */
  speciesHref: (speciesName: string) => string;
}

function TypeIcon({ type }: { type: string | null }) {
  if (type === "bird")
    return <Bird className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />;
  if (type === "mammal")
    return (
      <PawPrint className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
    );
  return null;
}

/**
 * The complete list of species recorded at the site, as a clean read-only
 * table — a companion to the photo carousel (which only shows species WITH a
 * photo). Sorted most-at-risk first (conservation story), then by detections.
 *
 * Deliberately NOT sortable: this is a public, mobile-first storytelling surface
 * for a non-technical landowner, not an internal data grid, so per-column sort
 * controls (the repo's SortIcon convention) would add noise without value. The
 * default ordering surfaces threatened species at the top.
 */
export function SpeciesTable({
  species,
  resolveImageUrl,
  speciesHref,
}: SpeciesTableProps) {
  if (species.length === 0) return null;
  const rows = sortSpeciesForTable(species);

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
          <ListTree className="h-3.5 w-3.5" />
          Todas las especies registradas
        </p>
        <p className="text-xs text-muted-foreground">
          {species.length}{" "}
          {species.length === 1 ? "especie encontrada" : "especies encontradas"}{" "}
          en su tierra.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-semibold">Especie</th>
              <th className="hidden px-3 py-2 text-right font-semibold sm:table-cell">
                Registros
              </th>
              <th className="px-3 py-2 font-semibold">Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((sp) => {
              const name = speciesCommonName(sp);
              const chip = iucnChip(sp.iucnStatus);
              const href =
                sp.photoImageId != null ? speciesHref(sp.speciesName) : null;
              return (
                <tr
                  key={sp.speciesName}
                  className="border-b last:border-0 align-middle even:bg-muted/20"
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      {sp.photoImageId != null ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={resolveImageUrl(sp.photoImageId, "thumb")}
                          alt={name}
                          className="h-9 w-9 flex-none rounded-md object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="h-9 w-9 flex-none rounded-md bg-muted" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <TypeIcon type={sp.taxonomicType} />
                          {href ? (
                            <a
                              href={href}
                              className="truncate font-semibold hover:underline"
                            >
                              {name}
                            </a>
                          ) : (
                            <span className="truncate font-semibold">
                              {name}
                            </span>
                          )}
                        </div>
                        <p className="truncate font-serif text-xs italic text-muted-foreground">
                          {sp.speciesName}
                        </p>
                        <span className="text-[11px] text-muted-foreground sm:hidden">
                          {sp.detectionCount}{" "}
                          {sp.detectionCount === 1 ? "registro" : "registros"}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                    {sp.detectionCount}
                  </td>
                  <td className="px-3 py-2.5">
                    {chip ? (
                      <span
                        className="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold text-white"
                        style={{ backgroundColor: chip.color }}
                      >
                        {chip.label}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
