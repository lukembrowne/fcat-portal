import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import {
  getGrants,
  getFunderOptions,
  type SortColumn,
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
import { EditableField, EditableStatus } from "./editable-cell";
import { EditableLinks } from "./editable-links";
import { EditableFunder } from "./editable-funder";
import { GrantsFilterBar } from "./grants-filter-bar";
import {
  GRANT_STATUS_LABELS,
  GRANT_STATUS_ORDER,
  toDateInput,
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
  const user = await requirePermission("grants", "viewer");
  const role = user.permissions.find((p) => p.projectId === "grants")?.role;
  const canEdit =
    user.globalRole === "super_admin" || role === "editor" || role === "admin";

  const params = await searchParams;

  const sortBy = (params.sortBy ?? "due") as SortColumn;
  const sortDir = (params.sortDir === "asc" ? "asc" : "desc") as SortDirection;

  const [rows, funderOptions] = await Promise.all([
    getGrants({
      status: params.status,
      search: params.search,
      needsLinking: params.needsLinking,
      sortBy,
      sortDir,
    }),
    canEdit ? getFunderOptions() : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {rows.length} grant{rows.length === 1 ? "" : "s"}
          {canEdit && (
            <span className="ml-2 text-xs">· click any cell to edit</span>
          )}
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
      <GrantsFilterBar
        select={{
          name: "status",
          allLabel: "All statuses",
          options: GRANT_STATUS_ORDER.map((s) => ({
            value: s,
            label: GRANT_STATUS_LABELS[s],
          })),
        }}
        searchPlaceholder="Search by grant or funder..."
        checkbox={{ name: "needsLinking", label: "Unlinked funder only", value: "1" }}
      />

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
                  <TableRow key={g.id} className="align-top">
                    <TableCell className="max-w-[320px]">
                      <div className="flex items-start gap-1">
                        <div className="min-w-0 flex-1">
                          <EditableField
                            id={g.id}
                            field="name"
                            value={g.name}
                            kind="text"
                            canEdit={canEdit}
                            placeholder="Grant name"
                          />
                          <EditableFunder
                            grantId={g.id}
                            funderId={g.funderId}
                            funderName={g.funderName}
                            funderNameRaw={g.funderNameRaw}
                            funderOptions={funderOptions}
                            canEdit={canEdit}
                          />
                        </div>
                        <Link
                          href={`/grants/${g.id}`}
                          title="Open grant"
                          className="relative z-10 mt-1 shrink-0 text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Link>
                      </div>
                    </TableCell>
                    <TableCell>
                      <EditableStatus grantId={g.id} value={g.status} canEdit={canEdit} />
                    </TableCell>
                    <TableCell className="text-right text-sm whitespace-nowrap">
                      <EditableField
                        id={g.id}
                        field="amountRequested"
                        value={g.amountRequested}
                        kind="amount"
                        canEdit={canEdit}
                        align="right"
                      />
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <EditableField
                          id={g.id}
                          field="dueDate"
                          value={toDateInput(g.dueDate)}
                          kind="date"
                          canEdit={canEdit}
                        />
                        {urgent && (
                          <Badge variant="secondary" className="bg-red-100 text-red-800 shrink-0">
                            {days}d
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <EditableLinks
                        grantId={g.id}
                        links={{
                          website: g.website,
                          folderLink: g.folderLink,
                          budgetLink: g.budgetLink,
                          proposalLink: g.proposalLink,
                        }}
                        canEdit={canEdit}
                      />
                    </TableCell>
                    <TableCell className="max-w-[260px]">
                      <EditableField
                        id={g.id}
                        field="notes"
                        value={g.notes}
                        kind="textarea"
                        canEdit={canEdit}
                        placeholder="Notes"
                      />
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
