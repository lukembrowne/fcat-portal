import Link from "next/link";
import { Headphones, Settings2 } from "lucide-react";

import { SortIcon } from "@/components/sort-icon";
import { speciesSlug } from "@/lib/species-slug";
import { rowAction, stageLabel } from "./labels";
import { NotesCell } from "./notes-cell";
import { normalizeSpeciesName } from "./species-import";
import { SpeciesRowActions } from "./species-row-actions";
import { StageTag } from "./stage-tag";
import type { CampaignSummary } from "./actions";

/**
 * `sampled` is deliberately absent. It is 200 for every drawn species and 0 for
 * every undrawn one, so as a sortable column it was a boolean wearing a number
 * — and it cost the width that made the table scroll. The sample size now rides
 * along as the denominator of `progress`.
 *
 * A bookmark carrying `?sortBy=sampled` degrades to the default sort through
 * the `SORTABLE_COLUMNS.includes(...)` guard on the page.
 */
export const SORTABLE_COLUMNS = [
  "species",
  "status",
  "progress",
  "reviewers",
  "precision",
  "threshold",
  "notes",
] as const;

export type SortColumn = (typeof SORTABLE_COLUMNS)[number];
export type SortDirection = "asc" | "desc";

export interface CampaignRow extends CampaignSummary {
  displayName: string;
  /** Applied threshold, or null when nothing is applied for this species. */
  appliedThreshold: number | null;
  /** Latest fit's 95% threshold, applied or not. */
  latestThreshold: number | null;
  /**
   * The latest row records "this species needs no filter" rather than a fitted
   * threshold. Its stored value is the score floor, which would otherwise print
   * as a suspiciously round `0.100` in the Umbral column.
   */
  latestIsNoFilter: boolean;
  unusableReason: string | null;
  totalDetections: number;
}

function precisionOf(row: CampaignRow): number | null {
  return row.reviewed > 0 ? row.correct / row.reviewed : null;
}

export interface CampaignFilter {
  /** Free text matched against the display name and the scientific name. */
  search: string;
  /** A CampaignStatus, "todas", or "activas" (everything but abandoned). */
  status: string;
}

/**
 * Narrow rows before sorting.
 *
 * Pure and exported for the same reason `sortCampaignRows` is: the matching
 * rules are the interesting part and they are testable without rendering.
 *
 * Search reuses `normalizeSpeciesName`, so what the table finds and what the
 * picker and bulk importer consider "the same name" cannot diverge — searching
 * "buho" finds "Búho" in all three.
 *
 * Notes are searched too, which is the point of importing them: the field
 * lists mark the doubtful species with a literal "CHECK", so typing it pulls
 * up exactly the ones somebody flagged.
 */
export function filterCampaignRows(
  rows: CampaignRow[],
  filter: CampaignFilter
): CampaignRow[] {
  const q = normalizeSpeciesName(filter.search ?? "");
  const status = filter.status || "activas";

  return rows.filter((row) => {
    if (status === "activas") {
      if (row.status === "abandoned") return false;
    } else if (status !== "todas" && row.status !== status) {
      return false;
    }

    if (!q) return true;
    return (
      normalizeSpeciesName(row.displayName).includes(q) ||
      normalizeSpeciesName(row.species).includes(q) ||
      normalizeSpeciesName(row.notes ?? "").includes(q)
    );
  });
}

/**
 * Sort rows by column.
 *
 * Pure and exported so the ordering is unit-testable without rendering. Nulls
 * always sort last regardless of direction — a species with no threshold yet is
 * not "smallest", it is absent, and burying it under real values in both
 * directions is what a reader expects.
 */
export function sortCampaignRows(
  rows: CampaignRow[],
  column: SortColumn,
  dir: SortDirection
): CampaignRow[] {
  const sign = dir === "asc" ? 1 : -1;

  const value = (row: CampaignRow): string | number | null => {
    switch (column) {
      case "species":
        return row.displayName.toLowerCase();
      case "status":
        return stageLabel(row.status);
      case "progress":
        // By what has been reviewed, not by the fraction: the denominators are
        // all 200, and a species with 3 of 200 sorts below one with 180 of 200
        // either way — but ordering by count keeps an undrawn species at the
        // bottom instead of at 0/0.
        return row.reviewed;
      case "reviewers":
        return row.reviewerCount;
      case "precision":
        return precisionOf(row);
      case "threshold":
        return row.appliedThreshold ?? row.latestThreshold;
      case "notes":
        // Null, not "", so a species with no note sorts last in BOTH
        // directions rather than heading the ascending list — the reader
        // sorting by this column is looking for the ones that have notes.
        return row.notes?.toLowerCase() || null;
    }
  };

  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return a.id - b.id;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va < vb) return -sign;
    if (va > vb) return sign;
    // Stable tiebreaker so pagination cannot interleave rows.
    return a.id - b.id;
  });
}

function SortableHeader({
  column,
  label,
  currentSort,
  currentDir,
  align,
  filter,
}: {
  column: SortColumn;
  label: string;
  currentSort: SortColumn;
  currentDir: SortDirection;
  align?: "right";
  filter: CampaignFilter;
}) {
  const isActive = currentSort === column;
  const nextDir = isActive && currentDir === "asc" ? "desc" : "asc";
  const query = new URLSearchParams({ sortBy: column, sortDir: nextDir });
  // Carried through, or clicking a header would silently clear the filter the
  // reader is looking at.
  if (filter.search) query.set("search", filter.search);
  if (filter.status && filter.status !== "activas") query.set("status", filter.status);

  // Every header but the first is indented, and none of them wrap. With eight
  // columns the table sits at its natural width, so the browser has no slack
  // left to distribute: without the padding "Revisadas" and "Revisores" touch,
  // and without the nowrap "Umbral 95%" breaks across two lines and runs into
  // the header beside it.
  return (
    <th
      className={`whitespace-nowrap py-1.5 ${column === "species" ? "" : "pl-2"} ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      <Link
        href={`/audio/validacion?${query.toString()}`}
        className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${
          align === "right" ? "flex-row-reverse" : ""
        }`}
      >
        {label}
        <SortIcon direction={isActive ? currentDir : false} />
      </Link>
    </th>
  );
}

export function CampaignTable({
  rows,
  sortBy,
  sortDir,
  filter,
  totalRows,
  canEdit,
}: {
  rows: CampaignRow[];
  sortBy: SortColumn;
  sortDir: SortDirection;
  filter: CampaignFilter;
  /** Rows before filtering, so an empty table can say why it is empty. */
  totalRows: number;
  /**
   * Editor or above on `grabaciones`. Only gates the notes cell's edit
   * affordance — `updateCampaignNotes` enforces the same permission itself.
   */
  canEdit: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {totalRows === 0
          ? "Todavía no se está validando ninguna especie."
          : "Ninguna especie coincide con el filtro."}
      </p>
    );
  }

  return (
    <table className="w-full min-w-[54rem] text-sm">
      <thead>
        <tr className="border-b text-xs text-muted-foreground">
          <SortableHeader column="species" label="Especie" currentSort={sortBy} currentDir={sortDir} filter={filter} />
          <SortableHeader column="status" label="Estado" currentSort={sortBy} currentDir={sortDir} filter={filter} />
          <SortableHeader column="progress" label="Revisadas" currentSort={sortBy} currentDir={sortDir} align="right" filter={filter} />
          <SortableHeader column="reviewers" label="Revisores" currentSort={sortBy} currentDir={sortDir} align="right" filter={filter} />
          <SortableHeader column="precision" label="Correctas" currentSort={sortBy} currentDir={sortDir} align="right" filter={filter} />
          <SortableHeader column="threshold" label="Umbral 95%" currentSort={sortBy} currentDir={sortDir} align="right" filter={filter} />
          {/* Last before the actions, so the numeric block stays contiguous:
              a free-text column between the counts pushes them apart and
              costs more to read than the notes gain. */}
          <SortableHeader column="notes" label="Notas" currentSort={sortBy} currentDir={sortDir} filter={filter} />
          {/* Not sortable — it holds an action, not an orderable value. */}
          <th className="whitespace-nowrap py-1.5 pl-2 text-right">Acción</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const precision = precisionOf(row);
          const action = rowAction(row.sampled);
          return (
            <tr key={row.id} className="border-b last:border-0 hover:bg-muted/50">
              <td className="py-1.5">
                <Link
                  href={`/audio/validacion/${speciesSlug(row.species)}`}
                  title="Progreso, umbral y ajustes de esta especie"
                  className="hover:underline"
                >
                  {row.displayName}
                </Link>
                <div className="text-[11px] italic text-muted-foreground">
                  {row.species}
                </div>
              </td>
              {/* The pill only. Both reasons are full sentences and rendering
                  either one inline is what made this column wider than the
                  species names — they live on the pill's tooltip and, at
                  length, on the species page. */}
              <td className="py-1.5 pl-2">
                <StageTag
                  status={row.status}
                  title={row.abandonedReason ?? row.unusableReason ?? undefined}
                />
              </td>
              <td className="py-1.5 pl-2 text-right tabular-nums">
                {row.sampled > 0 ? (
                  <>
                    {row.reviewed}
                    <span className="text-muted-foreground"> / {row.sampled}</span>
                    {row.uncertain > 0 ? (
                      <span className="text-[11px] text-muted-foreground">
                        {" "}
                        ({row.uncertain} inc.)
                      </span>
                    ) : null}
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="py-1.5 pl-2 text-right tabular-nums">
                {row.reviewerCount > 0 ? row.reviewerCount : "—"}
                {row.reviewerCount > 1 && !row.primaryReviewerEmail ? (
                  <span
                    className="ml-1 text-[11px] text-amber-700"
                    title="Varios revisores sin revisor principal: el modelo no puede ajustarse"
                  >
                    ⚠
                  </span>
                ) : null}
              </td>
              <td className="py-1.5 pl-2 text-right tabular-nums">
                {precision != null ? `${Math.round(precision * 100)}%` : "—"}
              </td>
              <td className="py-1.5 pl-2 text-right tabular-nums">
                {row.latestIsNoFilter ? (
                  <span
                    className={
                      row.appliedThreshold != null
                        ? "font-medium text-emerald-700"
                        : "text-muted-foreground"
                    }
                  >
                    Sin filtro
                  </span>
                ) : row.appliedThreshold != null ? (
                  <span className="font-medium text-emerald-700">
                    {row.appliedThreshold.toFixed(3)}
                  </span>
                ) : row.latestThreshold != null ? (
                  <span className="text-muted-foreground">
                    {row.latestThreshold.toFixed(3)}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              {/* One line, capped, full text on hover, editable in place —
                  notes-cell.tsx carries the reasoning for each of those. The
                  width cap is what keeps it to one line; the filter box
                  searches the note, and the species page shows it in full. */}
              <td className="max-w-[10rem] py-1.5 pl-2">
                <NotesCell
                  campaignId={row.id}
                  displayName={row.displayName}
                  notes={row.notes}
                  canEdit={canEdit}
                />
              </td>
              <td className="py-1.5 text-right">
                <span className="inline-flex items-center justify-end gap-1">
                  {/* Real links, not onClick handlers — right-click,
                      middle-click and keyboard activation all have to work.

                      One destination per control. A "Detalle" button used to
                      sit here too, pointing at exactly where the species name
                      already goes; two controls for one destination read as
                      redundancy, which is worse than the ambiguity it was
                      added to fix. The name carries a title instead. */}
                  <Link
                    href={`/audio/validacion/${speciesSlug(row.species)}${action.suffix}`}
                    title={action.title}
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                  >
                    {action.icon === "headphones" ? (
                      <Headphones className="h-3 w-3" />
                    ) : (
                      <Settings2 className="h-3 w-3" />
                    )}
                    {action.label}
                  </Link>
                  <SpeciesRowActions
                    campaignId={row.id}
                    species={row.species}
                    displayName={row.displayName}
                    status={row.status}
                    reviewerCount={row.reviewerCount}
                  />
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
