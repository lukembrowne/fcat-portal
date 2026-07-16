/**
 * Staff-facing IUCN Red List category code, shown next to species names in
 * internal views (species indexes, occupancy tables, species detail headers).
 *
 * This is deliberately DIFFERENT from `ConservationBadge` (the landowner-facing
 * badge): that one hides the raw code, renders only for threatened categories,
 * and uses a warm Spanish word. Staff instead want the plain abbreviation —
 * `(VU)`, `(EN)`, `(LC)` — for every meaningful assessed category. Do not merge
 * the two: the public badge's honesty contract depends on staying code-free.
 *
 * Data Deficient (DD), unassessed (null/empty), and unrecognized codes render
 * nothing, so the tag is always a real signal.
 */

interface IucnCategory {
  /** Full category name, surfaced as a tooltip. */
  name: string;
  className: string;
}

// Meaningful Red List categories worth surfacing to staff. DD (Data Deficient)
// and unknown/null are intentionally absent → render nothing.
const IUCN_BY_CODE: Record<string, IucnCategory> = {
  EX: { name: "Extinct", className: "text-neutral-100 bg-neutral-800 border-neutral-800" },
  EW: { name: "Extinct in the Wild", className: "text-neutral-100 bg-neutral-700 border-neutral-700" },
  CR: { name: "Critically Endangered", className: "text-white bg-red-600 border-red-600" },
  EN: { name: "Endangered", className: "text-white bg-red-500 border-red-500" },
  VU: { name: "Vulnerable", className: "text-white bg-amber-500 border-amber-500" },
  NT: { name: "Near Threatened", className: "text-yellow-950 bg-yellow-400 border-yellow-400" },
  LC: { name: "Least Concern", className: "text-emerald-800 bg-emerald-100 border-emerald-200" },
};

/** Pure lookup: returns the category for a code, or null when none should show. */
export function getIucnCategory(
  status: string | null | undefined,
): (IucnCategory & { code: string }) | null {
  if (!status) return null;
  const code = status.trim().toUpperCase();
  const cat = IUCN_BY_CODE[code];
  return cat ? { ...cat, code } : null;
}

export function IucnCode({
  status,
  className = "",
}: {
  status: string | null | undefined;
  className?: string;
}) {
  const cat = getIucnCategory(status);
  if (!cat) return null;
  return (
    <span
      title={`UICN: ${cat.name} (${cat.code})`}
      className={`inline-flex items-center rounded border px-1 py-0 text-[10px] font-semibold leading-tight align-middle ${cat.className} ${className}`}
    >
      {cat.code}
    </span>
  );
}
