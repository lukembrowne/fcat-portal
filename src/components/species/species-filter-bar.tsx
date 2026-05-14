"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  DEFAULT_STATUSES,
  VERIFICATION_STATUSES,
  type VerificationStatus,
} from "@/lib/species-search-params";
import type { ProjectOption } from "@/app/camera-trap/species/actions";

interface SpeciesFilterBarProps {
  /** Reserved for audio mode in Phase 3 (will gate a confidence slider). */
  mode?: "camera-trap" | "audio";
  projects: ProjectOption[];
  selectedStatuses: VerificationStatus[];
  selectedProjectId: number | null;
}

const STATUS_LABELS: Record<VerificationStatus, string> = {
  unverified: "Sin verificar",
  verified: "Verificadas",
  corrected: "Corregidas",
  rejected: "Rechazadas",
};

export function SpeciesFilterBar({
  projects,
  selectedStatuses,
  selectedProjectId,
}: SpeciesFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const statusSet = useMemo(() => new Set(selectedStatuses), [selectedStatuses]);
  const isDefaultStatuses =
    selectedStatuses.length === DEFAULT_STATUSES.length &&
    DEFAULT_STATUSES.every((s) => statusSet.has(s));

  const pushParams = useCallback(
    (next: URLSearchParams) => {
      // Filter changes reset expanded site + page (gap #10)
      next.delete("site");
      next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname]
  );

  const toggleStatus = (status: VerificationStatus) => {
    const next = new URLSearchParams(params);
    const newSet = new Set(statusSet);
    if (newSet.has(status)) newSet.delete(status);
    else newSet.add(status);
    if (newSet.size === 0) {
      next.delete("status");
    } else if (
      newSet.size === DEFAULT_STATUSES.length &&
      DEFAULT_STATUSES.every((s) => newSet.has(s))
    ) {
      next.delete("status");
    } else {
      next.set(
        "status",
        VERIFICATION_STATUSES.filter((s) => newSet.has(s)).join(",")
      );
    }
    pushParams(next);
  };

  const onProjectChange = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete("project");
    else next.set("project", value);
    pushParams(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm border-y py-3">
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground mr-1">Estado:</span>
        {VERIFICATION_STATUSES.map((status) => {
          const active = isDefaultStatuses
            ? DEFAULT_STATUSES.includes(status)
            : statusSet.has(status);
          return (
            <button
              key={status}
              type="button"
              onClick={() => toggleStatus(status)}
              className={`px-2 py-1 rounded border text-xs ${
                active
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background text-muted-foreground"
              }`}
            >
              {STATUS_LABELS[status]}
            </button>
          );
        })}
      </div>

      {projects.length > 1 && (
        <div className="flex items-center gap-2">
          <label
            htmlFor="species-project-filter"
            className="text-muted-foreground"
          >
            Proyecto:
          </label>
          <select
            id="species-project-filter"
            value={selectedProjectId == null ? "all" : String(selectedProjectId)}
            onChange={(e) => onProjectChange(e.target.value)}
            className="px-2 py-1 rounded border bg-background text-sm"
          >
            <option value="all">Todos</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
