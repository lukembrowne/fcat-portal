import Link from "next/link";
import { ChevronDown, ChevronRight, MapPin } from "lucide-react";
import type { SiteSummary } from "@/app/camera-trap/species/actions";
import type { ReactNode } from "react";

interface SiteListProps {
  sites: SiteSummary[];
  expandedSiteId: number | null;
  /** Builds an href that toggles the given site open. */
  buildToggleHref: (deploymentId: number | null) => string;
  /** Optional rendered content for the expanded site (image grid, audio cards). */
  expansionContent?: ReactNode;
  /** Optional href to a deployment detail page for cross-navigation. */
  buildDeploymentHref?: (deploymentId: number) => string;
  emptyState?: string;
}

function formatDate(unixSeconds: number | null): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString("es-EC", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function SiteList({
  sites,
  expandedSiteId,
  buildToggleHref,
  expansionContent,
  buildDeploymentHref,
  emptyState,
}: SiteListProps) {
  if (sites.length === 0) {
    return (
      <p className="text-muted-foreground text-sm py-8 text-center">
        {emptyState ?? "No hay detecciones que coincidan con los filtros."}
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {sites.map((s) => {
        const isOpen = s.deploymentId === expandedSiteId;
        return (
          <li key={s.deploymentId} id={`site-${s.deploymentId}`}>
            <Link
              href={buildToggleHref(isOpen ? null : s.deploymentId)}
              scroll={false}
              className="flex items-center gap-3 p-3 hover:bg-muted/40"
            >
              {isOpen ? (
                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{s.deploymentName}</div>
                <div className="text-xs text-muted-foreground flex gap-2 flex-wrap">
                  <span>
                    {s.detectionCount.toLocaleString("es-EC")}{" "}
                    {s.detectionCount === 1 ? "detección" : "detecciones"}
                  </span>
                  <span>· última {formatDate(s.lastSeen)}</span>
                  {s.latitude == null && (
                    <span className="inline-flex items-center gap-0.5 text-amber-600">
                      <MapPin className="w-3 h-3" /> sin ubicación
                    </span>
                  )}
                </div>
              </div>
              {buildDeploymentHref && (
                <span
                  className="text-xs text-muted-foreground underline ml-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Link href={buildDeploymentHref(s.deploymentId)}>Abrir</Link>
                </span>
              )}
            </Link>
            {isOpen && expansionContent && (
              <div className="border-t bg-muted/20 p-3">{expansionContent}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
