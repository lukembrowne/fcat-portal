import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { getFunder } from "../actions";
import { FunderForm } from "../funder-form";
import { DeleteFunderButton } from "./delete-funder-button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  GRANT_STATUS_LABELS,
  GRANT_STATUS_COLORS,
  formatUsd,
  formatDate,
  toDateInput,
} from "@/lib/grants/constants";
import type { GrantStatus } from "@/db/schema";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3 flex-1 min-w-[130px]">
      <div className="text-xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default async function FunderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("grants", "viewer");
  const { id } = await params;
  const funderId = parseInt(id, 10);
  if (isNaN(funderId)) notFound();

  const data = await getFunder(funderId);
  if (!data) notFound();

  const { funder, grants: linked, metrics } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/grants/funders" className="text-sm text-muted-foreground hover:underline">
            ← Funders
          </Link>
          <h2 className="text-xl font-bold mt-1">{funder.name}</h2>
        </div>
        <DeleteFunderButton id={funder.id} name={funder.name} grantCount={metrics.total} />
      </div>

      {/* Success metrics */}
      <div className="flex gap-3 flex-wrap">
        <Stat label="Grants" value={String(metrics.total)} />
        <Stat label="Funded" value={String(metrics.funded)} />
        <Stat
          label="Success rate"
          value={metrics.hitRate != null ? `${Math.round(metrics.hitRate * 100)}%` : "—"}
        />
        <Stat label="Total requested" value={formatUsd(metrics.totalRequested)} />
        <Stat label="Total awarded" value={formatUsd(metrics.totalAwarded)} />
      </div>

      {/* Linked grants */}
      <div>
        <h3 className="text-lg font-semibold mb-2">Linked grants</h3>
        {linked.length === 0 ? (
          <p className="text-sm text-muted-foreground">No linked grants.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Grant</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Requested</TableHead>
                <TableHead>Due date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {linked.map((g) => (
                <TableRow key={g.id} className="relative">
                  <TableCell>
                    <Link href={`/grants/${g.id}`} className="font-medium hover:underline">
                      {g.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className={GRANT_STATUS_COLORS[g.status as GrantStatus]}>
                      {GRANT_STATUS_LABELS[g.status as GrantStatus]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {formatUsd(g.amountRequested)}
                  </TableCell>
                  <TableCell className="text-sm">{formatDate(g.dueDate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Edit form */}
      <div>
        <h3 className="text-lg font-semibold mb-2">Edit funder</h3>
        <FunderForm
          initial={{
            id: funder.id,
            name: funder.name,
            website: funder.website,
            priority: funder.priority,
            funderType: funder.funderType,
            focusAreas: funder.focusAreas,
            relationshipManager: funder.relationshipManager,
            relationshipStatus: funder.relationshipStatus,
            nextSteps: funder.nextSteps,
            nextStepDue: toDateInput(funder.nextStepDue),
            contactName: funder.contactName,
            contactEmail: funder.contactEmail,
            fundingHistory: funder.fundingHistory,
            description: funder.description,
            notes: funder.notes,
            irs990Link: funder.irs990Link,
            guidestarLink: funder.guidestarLink,
            foundationDirectoryLink: funder.foundationDirectoryLink,
          }}
        />
      </div>
    </div>
  );
}
