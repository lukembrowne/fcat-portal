import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { getGrant, getFunderOptions, getGrantActivity } from "../actions";
import { GrantForm } from "../grant-form";
import { DeleteGrantButton } from "./delete-grant-button";
import { toDateInput, formatDateTime } from "@/lib/grants/constants";

export default async function GrantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("grants", "viewer");
  const { id } = await params;
  const grantId = parseInt(id, 10);
  if (isNaN(grantId)) notFound();

  const [row, funderOptions, activity] = await Promise.all([
    getGrant(grantId),
    getFunderOptions(),
    getGrantActivity(grantId),
  ]);
  if (!row) notFound();

  const g = row.grant;
  const lastUpdated = activity?.occurredAt ?? g.updatedAt;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/grants" className="text-sm text-muted-foreground hover:underline">
            ← Grants
          </Link>
          <h2 className="text-xl font-bold mt-1">{g.name}</h2>
          {row.funderName && (
            <p className="text-muted-foreground">{row.funderName}</p>
          )}
          {lastUpdated && (
            <p className="text-xs text-muted-foreground mt-1">
              Last updated {formatDateTime(lastUpdated)}
              {activity?.actorEmail ? ` by ${activity.actorEmail}` : ""}
            </p>
          )}
        </div>
        <DeleteGrantButton id={g.id} name={g.name} />
      </div>

      <GrantForm
        funderOptions={funderOptions}
        initial={{
          id: g.id,
          name: g.name,
          funderId: g.funderId,
          funderNameRaw: g.funderNameRaw,
          website: g.website,
          status: g.status,
          amountRequested: g.amountRequested,
          amountAwarded: g.amountAwarded,
          dueDate: toDateInput(g.dueDate),
          notes: g.notes,
          folderLink: g.folderLink,
          budgetLink: g.budgetLink,
          proposalLink: g.proposalLink,
        }}
      />
    </div>
  );
}
