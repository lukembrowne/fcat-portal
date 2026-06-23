import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import {
  getFunders,
  type FunderSortColumn,
  type SortDirection,
} from "./actions";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortIcon } from "@/components/sort-icon";
import { TruncatedCell } from "../truncated-cell";
import { FUNDER_PRIORITY_LABELS, formatDate } from "@/lib/grants/constants";
import { funderPriorityEnum } from "@/db/schema";

function buildQuery(
  params: Record<string, string | undefined>,
  overrides: Record<string, string>
): string {
  const q = new URLSearchParams();
  for (const key of ["priority", "search", "sortBy", "sortDir"]) {
    const v = overrides[key] ?? params[key];
    if (v && v !== "all") q.set(key, v);
  }
  return q.toString();
}

function SortableHeader({
  column,
  label,
  currentSort,
  currentDir,
  params,
  className,
}: {
  column: FunderSortColumn;
  label: string;
  currentSort: FunderSortColumn;
  currentDir: SortDirection;
  params: Record<string, string | undefined>;
  className?: string;
}) {
  const isActive = currentSort === column;
  const nextDir = isActive && currentDir === "asc" ? "desc" : "asc";
  const qs = buildQuery(params, { sortBy: column, sortDir: nextDir });
  return (
    <TableHead className={className}>
      <Link
        href={`/grants/funders?${qs}`}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors whitespace-nowrap"
      >
        {label}
        <SortIcon direction={isActive ? currentDir : false} />
      </Link>
    </TableHead>
  );
}

export default async function FundersPage({
  searchParams,
}: {
  searchParams: Promise<{
    priority?: string;
    search?: string;
    sortBy?: string;
    sortDir?: string;
  }>;
}) {
  await requirePermission("grants", "viewer");
  const params = await searchParams;

  const sortBy = (params.sortBy ?? "name") as FunderSortColumn;
  const sortDir = (params.sortDir === "desc" ? "desc" : "asc") as SortDirection;

  const rows = await getFunders({
    priority: params.priority,
    search: params.search,
    sortBy,
    sortDir,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {rows.length} funder{rows.length === 1 ? "" : "s"}
        </p>
        <Link
          href="/grants/funders/new"
          className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm shrink-0"
        >
          + Add Funder
        </Link>
      </div>

      <form className="flex gap-3 flex-wrap" method="GET">
        <select
          name="priority"
          defaultValue={params.priority ?? "all"}
          className="rounded-md border px-3 py-2 text-sm"
        >
          <option value="all">All priorities</option>
          {funderPriorityEnum.map((p) => (
            <option key={p} value={p}>
              {FUNDER_PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <input
          name="search"
          defaultValue={params.search ?? ""}
          placeholder="Search by name, manager, or focus area..."
          className="rounded-md border px-3 py-2 text-sm flex-1 min-w-[200px]"
        />
        <button type="submit" className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm">
          Filter
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center">No funders found.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader column="name" label="Funder" currentSort={sortBy} currentDir={sortDir} params={params} />
                <SortableHeader column="priority" label="Priority" currentSort={sortBy} currentDir={sortDir} params={params} />
                <SortableHeader column="type" label="Type" currentSort={sortBy} currentDir={sortDir} params={params} />
                <TableHead>Focus areas</TableHead>
                <SortableHeader column="manager" label="Manager" currentSort={sortBy} currentDir={sortDir} params={params} />
                <TableHead>Rel. status</TableHead>
                <SortableHeader column="nextStep" label="Next step due" currentSort={sortBy} currentDir={sortDir} params={params} />
                <TableHead>Next steps</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="text-right">Grants</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((f) => (
                <TableRow key={f.id} className="relative">
                  <TableCell className="max-w-[240px]">
                    <Link href={`/grants/funders/${f.id}`} className="font-medium hover:underline after:absolute after:inset-0">
                      <span className="block truncate" title={f.name}>{f.name}</span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    {f.priority ? (
                      <Badge variant="secondary">{FUNDER_PRIORITY_LABELS[f.priority]}</Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{f.funderType ?? "—"}</TableCell>
                  <TableCell><TruncatedCell text={f.focusAreas} /></TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{f.relationshipManager ?? "—"}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{f.relationshipStatus ?? "—"}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{formatDate(f.nextStepDue)}</TableCell>
                  <TableCell><TruncatedCell text={f.nextSteps} /></TableCell>
                  <TableCell className="text-sm whitespace-nowrap relative z-10">
                    {f.contactEmail ? (
                      <a href={`mailto:${f.contactEmail}`} className="hover:underline" title={f.contactName ?? undefined}>
                        {f.contactName ?? f.contactEmail}
                      </a>
                    ) : (
                      f.contactName ?? "—"
                    )}
                  </TableCell>
                  <TableCell><TruncatedCell text={f.description} /></TableCell>
                  <TableCell><TruncatedCell text={f.notes} /></TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{f.grantCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
