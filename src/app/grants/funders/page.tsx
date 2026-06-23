import Link from "next/link";
import { ExternalLink, Globe, User, Mail } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import {
  getFunders,
  updateFunderField,
  type FunderSortColumn,
  type SortDirection,
} from "./actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortIcon } from "@/components/sort-icon";
import { EditableField, EditableSelect } from "../editable-cell";
import { GrantsFilterBar } from "../grants-filter-bar";
import { FUNDER_PRIORITY_LABELS, toDateInput } from "@/lib/grants/constants";
import { funderPriorityEnum } from "@/db/schema";

/** Coerce a stored website value into a safe href (default to https://). */
function toHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

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
  const user = await requirePermission("grants", "viewer");
  const role = user.permissions.find((p) => p.projectId === "grants")?.role;
  const canEdit =
    user.globalRole === "super_admin" || role === "editor" || role === "admin";

  const params = await searchParams;

  const sortBy = (params.sortBy ?? "name") as FunderSortColumn;
  const sortDir = (params.sortDir === "desc" ? "desc" : "asc") as SortDirection;

  const rows = await getFunders({
    priority: params.priority,
    search: params.search,
    sortBy,
    sortDir,
  });

  const priorityOptions = funderPriorityEnum.map((p) => ({
    value: p,
    label: FUNDER_PRIORITY_LABELS[p],
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {rows.length} funder{rows.length === 1 ? "" : "s"}
          {canEdit && (
            <span className="ml-2 text-xs">· click any cell to edit</span>
          )}
        </p>
        <Link
          href="/grants/funders/new"
          className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm shrink-0"
        >
          + Add Funder
        </Link>
      </div>

      <GrantsFilterBar
        select={{
          name: "priority",
          allLabel: "All priorities",
          options: funderPriorityEnum.map((p) => ({
            value: p,
            label: FUNDER_PRIORITY_LABELS[p],
          })),
        }}
        searchPlaceholder="Search by name, manager, or focus area..."
      />

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
                <TableHead>Website</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="text-right">Grants</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((f) => (
                <TableRow key={f.id} className="align-top">
                  <TableCell className="max-w-[240px]">
                    <div className="flex items-start gap-1">
                      <div className="min-w-0 flex-1">
                        <EditableField
                          id={f.id}
                          field="name"
                          value={f.name}
                          kind="text"
                          canEdit={canEdit}
                          action={updateFunderField}
                          placeholder="Funder name"
                        />
                      </div>
                      <Link
                        href={`/grants/funders/${f.id}`}
                        title="Open funder"
                        className="relative z-10 mt-1 shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell>
                    <EditableSelect
                      id={f.id}
                      field="priority"
                      value={f.priority}
                      options={priorityOptions}
                      canEdit={canEdit}
                      action={updateFunderField}
                    />
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">
                    <EditableField id={f.id} field="funderType" value={f.funderType} kind="text" canEdit={canEdit} action={updateFunderField} placeholder="Type" />
                  </TableCell>
                  <TableCell className="max-w-[200px]">
                    <EditableField id={f.id} field="focusAreas" value={f.focusAreas} kind="textarea" canEdit={canEdit} action={updateFunderField} placeholder="Focus areas" />
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">
                    <EditableField id={f.id} field="relationshipManager" value={f.relationshipManager} kind="text" canEdit={canEdit} action={updateFunderField} placeholder="Manager" />
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">
                    <EditableField id={f.id} field="relationshipStatus" value={f.relationshipStatus} kind="text" canEdit={canEdit} action={updateFunderField} placeholder="Rel. status" />
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">
                    <EditableField id={f.id} field="nextStepDue" value={toDateInput(f.nextStepDue)} kind="date" canEdit={canEdit} action={updateFunderField} />
                  </TableCell>
                  <TableCell className="max-w-[200px]">
                    <EditableField id={f.id} field="nextSteps" value={f.nextSteps} kind="textarea" canEdit={canEdit} action={updateFunderField} placeholder="Next steps" />
                  </TableCell>
                  <TableCell className="min-w-[160px] max-w-[200px] text-sm">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <User className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <EditableField id={f.id} field="contactName" value={f.contactName} kind="text" canEdit={canEdit} action={updateFunderField} placeholder="Name" />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Mail className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          {canEdit ? (
                            <EditableField id={f.id} field="contactEmail" value={f.contactEmail} kind="text" canEdit={canEdit} action={updateFunderField} placeholder="Email" />
                          ) : f.contactEmail ? (
                            <a href={`mailto:${f.contactEmail}`} className="truncate text-primary hover:underline">
                              {f.contactEmail}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="min-w-[140px] max-w-[200px] text-sm">
                    <div className="flex items-center gap-1">
                      <div className="min-w-0 flex-1">
                        <EditableField id={f.id} field="website" value={f.website} kind="text" canEdit={canEdit} action={updateFunderField} placeholder="Website URL" />
                      </div>
                      {f.website && (
                        <a
                          href={toHref(f.website)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Visit website"
                          className="relative z-10 shrink-0 text-muted-foreground hover:text-foreground"
                        >
                          <Globe className="h-4 w-4" />
                        </a>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[200px]">
                    <EditableField id={f.id} field="description" value={f.description} kind="textarea" canEdit={canEdit} action={updateFunderField} placeholder="Description" />
                  </TableCell>
                  <TableCell className="max-w-[200px]">
                    <EditableField id={f.id} field="notes" value={f.notes} kind="textarea" canEdit={canEdit} action={updateFunderField} placeholder="Notes" />
                  </TableCell>
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
