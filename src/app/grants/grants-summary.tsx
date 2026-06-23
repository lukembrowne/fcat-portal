import { getGrantsSummary } from "./actions";
import { formatUsd } from "@/lib/grants/constants";

function Card({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "pending" | "success" | "default";
}) {
  const valueColor =
    tone === "pending"
      ? "text-amber-600"
      : tone === "success"
        ? "text-green-600"
        : "text-foreground";
  return (
    <div className="rounded-lg border bg-card px-4 py-3 flex-1 min-w-[150px]">
      <div className={`text-2xl font-bold ${valueColor}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

/** Summary cards reproducing the n8n monthly-digest header. */
export async function GrantsSummary() {
  const s = await getGrantsSummary();
  return (
    <div className="space-y-2">
      <div className="flex gap-3 flex-wrap">
        <Card label="Grants awaiting decision" value={s.pendingCount} tone="pending" />
        <Card label="Requested · awaiting decision" value={formatUsd(s.pendingAmount)} tone="pending" />
        <Card label="Grants funded" value={s.fundedCount} tone="success" />
        <Card label="Requested · funded grants" value={formatUsd(s.fundedAmount)} tone="success" />
      </div>
      <p className="text-xs text-muted-foreground">
        All-time totals across every grant — not limited to the current year or active pipeline.
        Dollar figures are the amounts <em>requested</em>.
      </p>
    </div>
  );
}
