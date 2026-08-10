"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Star, X } from "lucide-react";

import {
  removeReviewer,
  setPrimaryReviewer,
  type ReviewerProgress,
} from "@/app/audio/validacion/actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Display label for a reviewer: their portal name when we have one, else the
 * email. Reviewers may be external accounts with no `users` row.
 */
export function reviewerLabel(reviewer: { email: string; name: string | null }): string {
  return reviewer.name?.trim() || reviewer.email;
}

/** "45 / 200" plus a percentage, or a Spanish placeholder before any sample. */
export function formatReviewerProgress(reviewed: number, sampled: number): string {
  if (sampled === 0) return "sin muestra";
  const pct = Math.round((reviewed / sampled) * 100);
  return `${reviewed} / ${sampled} (${pct}%)`;
}

interface ReviewerRosterProps {
  campaignId: number;
  canEdit: boolean;
  sampled: number;
  reviewers: ReviewerProgress[];
}

export function ReviewerRoster({
  campaignId,
  canEdit,
  sampled,
  reviewers,
}: ReviewerRosterProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null
  );

  const run = async (key: string, fn: () => Promise<{ success: boolean; error?: string }>) => {
    setBusy(key);
    setMessage(null);
    try {
      const result = await fn();
      if (!result.success) {
        setMessage({ tone: "err", text: result.error ?? "Error" });
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Revisores</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Says how someone gets on this list, now that there is no button
            that puts them there. */}
        <p className="text-[11px] text-muted-foreground">
          Cada persona aparece aquí al responder su primera detección. Todos
          revisan las mismas grabaciones: el modelo usa únicamente las respuestas
          del revisor principal (★) y las demás sirven para medir la
          concordancia.
        </p>

        {reviewers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nadie ha revisado esta especie todavía.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {reviewers.map((r) => (
              <li
                key={r.email}
                className="flex items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    {r.isPrimary ? (
                      <Star
                        className="size-3.5 shrink-0 fill-amber-400 text-amber-500"
                        aria-label="Revisor principal"
                      />
                    ) : null}
                    <span className="truncate text-sm font-medium">
                      {reviewerLabel(r)}
                    </span>
                  </div>
                  <div className="text-[11px] tabular-nums text-muted-foreground">
                    {formatReviewerProgress(r.reviewed, sampled)}
                    {r.reviewed > 0
                      ? ` · ${r.correct} correctas, ${r.incorrect} incorrectas, ${r.uncertain} inciertas`
                      : ""}
                  </div>
                </div>

                {canEdit ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {!r.isPrimary ? (
                      <button
                        type="button"
                        className="rounded border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
                        disabled={busy !== null}
                        onClick={() =>
                          run(`primary-${r.email}`, () =>
                            setPrimaryReviewer(campaignId, r.email)
                          )
                        }
                      >
                        {busy === `primary-${r.email}` ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          "Hacer principal"
                        )}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Quitar a ${reviewerLabel(r)}`}
                      className="rounded border p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
                      disabled={busy !== null}
                      onClick={() =>
                        run(`remove-${r.email}`, () =>
                          removeReviewer(campaignId, r.email)
                        )
                      }
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {/*
          There is deliberately no "add a reviewer" form. It looked like it
          invited someone and did neither of the two things that implies: no
          mail was sent, and no access was granted — reviewing is gated on the
          portal's own editor permission for Grabaciones, never on this list.
          All it did was pre-create a 0/200 row. Reviewers enrol themselves on
          their first answer (`ensureRostered` in `recordReview`), which is the
          only moment the row carries any information.
        */}

        {message ? (
          <p
            className={
              message.tone === "err"
                ? "text-[11px] text-red-600"
                : "text-[11px] text-emerald-700"
            }
          >
            {message.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
