/**
 * Honest conservation/rarity badge driven by an IUCN Red List category code.
 *
 * Only threatened / near-threatened categories render a badge — Least Concern
 * (LC), Data Deficient (DD), and unassessed (null) render nothing, so the badge
 * is a genuine signal rather than decoration. The raw code is never shown to the
 * landowner; only a warm Spanish label.
 */

interface ConservationInfo {
  label: string;
  className: string;
}

// Codes worth surfacing. LC/DD/EW/EX and anything unknown → no badge.
const CONSERVATION_BY_CODE: Record<string, ConservationInfo> = {
  CR: {
    label: "En peligro crítico",
    className: "bg-red-600 text-white",
  },
  EN: {
    label: "En peligro",
    className: "bg-red-500 text-white",
  },
  VU: {
    label: "Vulnerable",
    className: "bg-amber-500 text-white",
  },
  NT: {
    label: "Casi amenazada",
    className: "bg-yellow-400 text-yellow-950",
  },
};

/** Pure mapping: returns badge info for a status code, or null when none applies. */
export function getConservationInfo(
  status: string | null | undefined
): ConservationInfo | null {
  if (!status) return null;
  return CONSERVATION_BY_CODE[status.toUpperCase()] ?? null;
}

export function ConservationBadge({
  status,
}: {
  status: string | null | undefined;
}) {
  const info = getConservationInfo(status);
  if (!info) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold shadow-sm ${info.className}`}
    >
      {info.label}
    </span>
  );
}
