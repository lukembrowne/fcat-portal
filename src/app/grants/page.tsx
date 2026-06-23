import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getGrants, type SortColumn, type SortDirection } from "./actions";
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
import { TruncatedCell } from "./truncated-cell";
import {
  GRANT_STATUS_LABELS,
  GRANT_STATUS_COLORS,
  GRANT_STATUS_ORDER,
  formatUsd,
  formatDate,
  daysUntil,
} from "@/lib/grants/constants";
import { GrantsSummary } from "./grants-summary";

function buildQuery(
  params: Record<string, string | undefined>,
  overrides: Record<string, string>
): string {
  const q = new URLSearchParams();
  for (const key of ["status", "search", "needsLinking", "sortBy", "sortDir"]) {
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
  column: SortColumn;
  label: string;
  currentSort: SortColumn;
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
        href={`/grants?${qs}`}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors whitespace-nowrap"
      >
        {label}
        <SortIcon direction={isActive ? currentDir : false} />
      </Link>
    </TableHead>
  );
}

function LinkChips({
  links,
}: {
  links: { label: string; href: string | null }[];
}) {
  const present = links.filter((l) => l.href);
  if (present.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex gap-1.5 relative z-10">
      {present.map((l) => (
        <a
          key={l.label}
          href={l.href!}
          target="_blank"
          rel="noopener noreferrer"
          title={l.label}
          className="inline-flex h-5 w-5 items-center justify-center rounded border text-[10px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {l.label[0]}
        </a>
      ))}
    </div>
  );
}

export default async function GrantsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    search?: string;
    needsLinking?: string;
    sortBy?: string;
    sortDir?: string;
  }>;
}) {
  await requirePermission("grants", "viewer");
  const params = await searchParams;

  const sortBy = (params.sortBy ?? "due") as SortColumn;
  const sortDir = (params.sortDir === "asc" ? "asc" : "desc") as SortDirection;

  const rows = await getGrants({
    status: params.status,
    search: params.search,
    needsLinking: params.needsLinking,
    sortBy,
    sortDir,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {rows.length} grant{rows.length === 1 ? "" : "s"}
        </p>
        <Link
          href="/grants/new"
          className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm shrink-0"
        >
          + Add Grant
        </Link>
      </div>

      <GrantsSummary />

      {/* Filters */}
      <form className="flex gap-3 flex-wrap" method="GET">
        <select
          name="status"
          defaultValue={params.status ?? "all"}
          className="rounded-md border px-3 py-2 text-sm"
        >
          <option value="all">All statuses</option>
          {GRANT_STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {GRANT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <input
          name="search"
          defaultValue={params.search ?? ""}
          placeholder="Search by grant or funder..."
          className="rounded-md border px-3 py-2 text-sm flex-1 min-w-[200px]"
        />
        <label className="flex items-center gap-2 text-sm px-2">
          <input
            type="checkbox"
            name="needsLinking"
            value="1"
            defaultChecked={params.needsLinking === "1"}
          />
          Unlinked funder only
        </label>
        <button
          type="submit"
          className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm"
        >
          Filter
        </button>
      </form>

      {/* Table */}
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center">No grants found.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader column="name" label="Grant" currentSort={sortBy} currentDir={sortDir} params={params} />
                <SortableHeader column="status" label="Status" currentSort={sortBy} currentDir={sortDir} params={params} />
                <SortableHeader column="amount" label="Requested" currentSort={sortBy} currentDir={sortDir} params={params} className="text-right" />
                <SortableHeader column="due" label="Due date" currentSort={sortBy} currentDir={sortDir} params={params} />
                <SortableHeader column="notify" label="Notify (days)" currentSort={sortBy} currentDir={sortDir} params={params} className="text-right" />
                <SortableHeader column="rfp" label="RFP check" currentSort={sortBy} currentDir={sortDir} params={params} />
                <TableHead>Links</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((g) => {
                const days = daysUntil(g.dueDate);
                const isActive = !["funded", "rejected", "passed", "completed"].includes(g.status);
                const urgent = isActive && days != null && days >= 0 && days <= 7;
                return (
                  <TableRow key={g.id} className="relative">
                    <TableCell className="max-w-[320px]">
                      <Link
                        href={`/grants/${g.id}`}
                        className="font-medium hover:underline after:absolute after:inset-0"
                      >
                        <span className="block truncate" title={g.name}>
                          {g.name}
                        </span>
                      </Link>
                      {g.funderId && g.funderName ? (
                        <Link
                          href={`/grants/funders/${g.funderId}`}
                          className="relative z-10 mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                          title={`View funder: ${g.funderName}`}
                        >
                          ↗ {g.funderName}
                        </Link>
                      ) : g.funderNameRaw ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground italic">
                          {g.funderNameRaw}{" "}
                          <Badge variant="secondary" className="bg-amber-100 text-amber-800">
                            unlinked
                          </Badge>
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={GRANT_STATUS_COLORS[g.status]}>
                        {GRANT_STATUS_LABELS[g.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm whitespace-nowrap">
                      {formatUsd(g.amountRequested)}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatDate(g.dueDate)}
                      {urgent && (
                        <Badge variant="secondary" className="bg-red-100 text-red-800 ml-2">
                          {days}d
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{g.notifyBeforeDays}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{formatDate(g.checkRfpDate)}</TableCell>
                    <TableCell>
                      <LinkChips
                        links={[
                          { label: "Website", href: g.website },
                          { label: "Folder", href: g.folderLink },
                          { label: "Budget", href: g.budgetLink },
                          { label: "Proposal", href: g.proposalLink },
                        ]}
                      />
                    </TableCell>
                    <TableCell>
                      <TruncatedCell text={g.notes} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
