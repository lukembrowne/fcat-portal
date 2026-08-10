import Link from "next/link";

import type { ReviewerAgreement } from "@/app/audio/validacion/actions";
import { describeKappa } from "@/lib/birdnet-validation/agreement";
import { KAPPA_REASON_ES } from "@/lib/birdnet-validation/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { reviewerLabel } from "./reviewer-roster";

interface AgreementPanelProps {
  slug: string;
  hasPrimary: boolean;
  agreement: ReviewerAgreement[];
  disagreementCount: number;
}

/**
 * Each reviewer's agreement with the designated primary.
 *
 * Percent agreement is reported alongside kappa rather than instead of it: for
 * a species where almost everything is a false positive, two reviewers can
 * agree 90% of the time purely by both saying "incorrect", and only kappa
 * shows that.
 */
export function AgreementPanel({
  slug,
  hasPrimary,
  agreement,
  disagreementCount,
}: AgreementPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Concordancia entre revisores</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!hasPrimary ? (
          <p className="text-sm text-muted-foreground">
            Designe un revisor principal para medir la concordancia: las
            comparaciones se hacen contra sus respuestas.
          </p>
        ) : agreement.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay otro revisor con grabaciones en común.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[11px] text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Revisor</th>
                    <th className="py-1 pr-2 text-right font-medium">En común</th>
                    <th className="py-1 pr-2 text-right font-medium">Coincidencia</th>
                    <th className="py-1 font-medium">Kappa</th>
                  </tr>
                </thead>
                <tbody>
                  {agreement.map((a) => (
                    <tr key={a.email} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">{reviewerLabel(a)}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{a.n}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {a.percentAgreement === null
                          ? "—"
                          : `${Math.round(a.percentAgreement * 100)}%`}
                      </td>
                      <td className="py-1.5">
                        {a.kappa === null ? (
                          <span className="text-[11px] text-muted-foreground">
                            {a.kappaReason ? KAPPA_REASON_ES[a.kappaReason] : "—"}
                          </span>
                        ) : (
                          <span className="tabular-nums">
                            {a.kappa.toFixed(2)}{" "}
                            <span className="text-[11px] text-muted-foreground">
                              ({describeKappa(a)})
                            </span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {disagreementCount > 0 ? (
              <Link
                href={`/audio/validacion/${slug}/desacuerdos`}
                className="inline-block text-sm text-sky-700 hover:underline"
              >
                Ver {disagreementCount}{" "}
                {disagreementCount === 1 ? "desacuerdo" : "desacuerdos"}
              </Link>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Sin desacuerdos entre revisores.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
