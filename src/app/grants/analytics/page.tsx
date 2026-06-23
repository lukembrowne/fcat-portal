import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getGrantAnalytics } from "./actions";
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
  FORECAST_WEIGHTS,
  formatUsd,
} from "@/lib/grants/constants";

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

export default async function GrantAnalyticsPage() {
  await requirePermission("grants", "viewer");
  const a = await getGrantAnalytics();

  const maxYearReq = Math.max(1, ...a.byYear.map((y) => y.totalRequested));

  return (
    <div className="space-y-8">
      <p className="text-muted-foreground text-sm">
        Success rate, amounts by year, and pipeline forecast
      </p>

      {/* Pipeline forecast */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Pipeline forecast</h2>
        <div className="flex gap-3 flex-wrap">
          <div className="rounded-lg border bg-card px-4 py-3 flex-1 min-w-[180px]">
            <div className="text-2xl font-bold text-green-600">{formatUsd(a.forecast.totalWeighted)}</div>
            <div className="text-xs text-muted-foreground">Expected value (weighted by stage)</div>
          </div>
          <div className="rounded-lg border bg-card px-4 py-3 flex-1 min-w-[180px]">
            <div className="text-2xl font-bold">{formatUsd(a.forecast.activeRequested)}</div>
            <div className="text-xs text-muted-foreground">Active requested (In Preparation + Pending Decision)</div>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground space-y-2">
          <p>
            <span className="font-medium text-foreground">Expected value</span> = Σ (amount requested ×
            stage probability) across all grants. It estimates how much funding we can expect from the
            current pipeline, discounting each grant by how likely it is to land.
          </p>
          <p>
            <span className="font-medium text-foreground">Stage probabilities (assumptions):</span>{" "}
            To Research {pct(FORECAST_WEIGHTS.to_research)}, In Preparation {pct(FORECAST_WEIGHTS.in_prep)},
            Pending Decision {pct(FORECAST_WEIGHTS.pending_decision)}, Funded {pct(FORECAST_WEIGHTS.funded)}.
            Rejected, Passed, and Completed contribute $0 (no longer open opportunities).
          </p>
          <p>
            <span className="font-medium text-foreground">Active requested</span> is the raw (un-weighted)
            total requested across grants currently In Preparation or Pending Decision.
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stage</TableHead>
              <TableHead className="text-right">Win prob.</TableHead>
              <TableHead className="text-right">#</TableHead>
              <TableHead className="text-right">Requested</TableHead>
              <TableHead className="text-right">Expected value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {a.forecast.rows.map((r) => (
              <TableRow key={r.status}>
                <TableCell>{GRANT_STATUS_LABELS[r.status]}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {pct(FORECAST_WEIGHTS[r.status])}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                <TableCell className="text-right tabular-nums">{formatUsd(r.sumRequested)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.weighted > 0 ? formatUsd(r.weighted) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      {/* Win rate & $ by year */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">By year</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Year</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Funded</TableHead>
              <TableHead className="text-right">Success rate</TableHead>
              <TableHead className="text-right">Requested</TableHead>
              <TableHead>&nbsp;</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {a.byYear.map((y) => (
              <TableRow key={y.year}>
                <TableCell className="font-medium">{y.year}</TableCell>
                <TableCell className="text-right tabular-nums">{y.total}</TableCell>
                <TableCell className="text-right tabular-nums">{y.funded}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(y.winRate)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatUsd(y.totalRequested)}</TableCell>
                <TableCell className="w-[160px]">
                  <div className="h-2 rounded bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${(y.totalRequested / maxYearReq) * 100}%` }}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      {/* Success rate by funder */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">By funder</h2>
        {a.byFunder.length === 0 ? (
          <p className="text-sm text-muted-foreground">No grants linked to funders yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Funder</TableHead>
                <TableHead className="text-right">Applications</TableHead>
                <TableHead className="text-right">Funded</TableHead>
                <TableHead className="text-right">Success rate</TableHead>
                <TableHead className="text-right">Requested</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.byFunder.slice(0, 25).map((f) => (
                <TableRow key={f.funderId} className="relative">
                  <TableCell>
                    <Link href={`/grants/funders/${f.funderId}`} className="font-medium hover:underline">
                      {f.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{f.total}</TableCell>
                  <TableCell className="text-right tabular-nums">{f.funded}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(f.hitRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(f.totalRequested)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {a.byFunder.length > 25 && (
          <p className="text-xs text-muted-foreground">Showing the 25 funders with the most applications.</p>
        )}
      </section>
    </div>
  );
}
