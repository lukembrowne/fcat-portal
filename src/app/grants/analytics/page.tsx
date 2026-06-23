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
import { Badge } from "@/components/ui/badge";
import {
  GRANT_STATUS_LABELS,
  GRANT_STATUS_COLORS,
  formatUsd,
  TOTAL_KEY,
} from "@/lib/grants/constants";

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

export default async function GrantAnalyticsPage() {
  await requirePermission("grants", "viewer");
  const a = await getGrantAnalytics();
  const { matrix } = a;
  const colKeys = [...matrix.years, TOTAL_KEY];

  function colLabel(key: string): string {
    return key === TOTAL_KEY ? "Total" : key;
  }

  return (
    <div className="space-y-8">
      <p className="text-muted-foreground text-sm">
        Grant counts by stage and year, success rate, and funder hit rates
      </p>

      {/* Stage × year matrix */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">By stage &amp; year</h2>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stage</TableHead>
                {colKeys.map((k) => (
                  <TableHead
                    key={k}
                    className={`text-right whitespace-nowrap ${k === TOTAL_KEY ? "font-semibold" : ""}`}
                  >
                    {colLabel(k)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {matrix.statuses.map((s) => (
                <TableRow key={s}>
                  <TableCell>
                    <Badge variant="secondary" className={GRANT_STATUS_COLORS[s]}>
                      {GRANT_STATUS_LABELS[s]}
                    </Badge>
                  </TableCell>
                  {colKeys.map((k) => {
                    const n = matrix.counts[s][k] ?? 0;
                    return (
                      <TableCell
                        key={k}
                        className={`text-right tabular-nums ${k === TOTAL_KEY ? "font-semibold" : ""}`}
                      >
                        {n === 0 ? <span className="text-muted-foreground">—</span> : n}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {/* Totals */}
              <TableRow className="border-t-2">
                <TableCell className="font-medium">All grants</TableCell>
                {colKeys.map((k) => (
                  <TableCell
                    key={k}
                    className={`text-right tabular-nums font-medium ${k === TOTAL_KEY ? "font-semibold" : ""}`}
                  >
                    {matrix.totalsByYear[k] || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                ))}
              </TableRow>
              {/* Success rate */}
              <TableRow>
                <TableCell className="font-medium">Success rate</TableCell>
                {colKeys.map((k) => (
                  <TableCell
                    key={k}
                    className={`text-right tabular-nums font-medium ${k === TOTAL_KEY ? "font-semibold" : ""}`}
                  >
                    {pct(matrix.successByYear[k])}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground max-w-2xl">
          <span className="font-medium text-foreground">Success rate</span> = (Funded + Completed) ÷
          grants we applied to and got a verdict on (Funded + Completed + Rejected).{" "}
          <span className="font-medium text-foreground">Passed</span> grants (opportunities we chose not
          to pursue) and undecided grants (To Research, In Preparation, Pending Decision) are excluded
          from the calculation. Years are grouped by the grant&apos;s due date.
        </p>
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
