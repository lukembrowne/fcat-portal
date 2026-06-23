"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { saveGrant } from "./actions";
import { FunderPicker } from "./funder-picker";
import type { GrantStatus } from "@/db/schema";
import {
  GRANT_STATUS_LABELS,
  GRANT_STATUS_ORDER,
} from "@/lib/grants/constants";

export interface GrantFormInitial {
  id?: number;
  name: string;
  funderId: number | null;
  funderNameRaw: string | null;
  website: string | null;
  status: GrantStatus;
  amountRequested: number | null;
  amountAwarded: number | null;
  dueDate: string | null; // YYYY-MM-DD
  notifyBeforeDays: number;
  checkRfpDate: string | null; // YYYY-MM-DD
  notes: string | null;
  folderLink: string | null;
  budgetLink: string | null;
  proposalLink: string | null;
}

const inputCls = "rounded-md border bg-white px-3 py-2 text-sm w-full";

function Field({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium">{label}</label>
      {desc && <p className="text-xs text-muted-foreground mb-1">{desc}</p>}
      <div className={desc ? "" : "mt-1"}>{children}</div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card shadow-sm p-4 space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function GrantForm({
  initial,
  funderOptions,
}: {
  initial: GrantFormInitial;
  funderOptions: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(saveGrant, null);

  const initialFunderName =
    funderOptions.find((f) => f.id === initial.funderId)?.name ?? null;

  useEffect(() => {
    if (state?.success) {
      router.push(`/grants/${state.data.id}`);
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-4 max-w-2xl">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}

      {state && !state.success && (
        <div className="rounded-md bg-red-50 border border-red-200 text-red-800 px-3 py-2 text-sm">
          {state.error}
        </div>
      )}

      <Section title="Grant">
        <Field label="Grant name *" desc="The name of the grant or funding opportunity.">
          <input name="name" required defaultValue={initial.name} className={inputCls} />
        </Field>

        <Field
          label="Funder"
          desc="Search the directory, or use 'Add funder' if it isn't listed yet."
        >
          <FunderPicker
            funders={funderOptions}
            initialFunderId={initial.funderId}
            initialFunderName={initialFunderName}
          />
        </Field>

        <Field
          label="Funder name (unlinked)"
          desc="Use only if the funder isn't in the directory — shows as 'unlinked' until matched."
        >
          <input
            name="funderNameRaw"
            defaultValue={initial.funderNameRaw ?? ""}
            placeholder="One-off funder name"
            className={inputCls}
          />
        </Field>
      </Section>

      <Section title="Notes">
        <Field label="Notes" desc="Anything useful — eligibility, contacts, reminders.">
          <textarea name="notes" rows={4} defaultValue={initial.notes ?? ""} className={inputCls} />
        </Field>
      </Section>

      <Section title="Status & funding">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Status" desc="Where this grant sits in the pipeline.">
            <select name="status" defaultValue={initial.status} className={inputCls}>
              {GRANT_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {GRANT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due date" desc="Submission deadline.">
            <input type="date" name="dueDate" defaultValue={initial.dueDate ?? ""} className={inputCls} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount requested (USD)" desc="How much we asked for.">
            <input
              name="amountRequested"
              inputMode="decimal"
              defaultValue={initial.amountRequested ?? ""}
              className={inputCls}
            />
          </Field>
          <Field label="Amount awarded (USD)" desc="Fill in once the grant is funded.">
            <input
              name="amountAwarded"
              inputMode="decimal"
              defaultValue={initial.amountAwarded ?? ""}
              className={inputCls}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Notify before (days)" desc="Days before the deadline to send a reminder (0–365).">
            <input
              type="number"
              name="notifyBeforeDays"
              min={0}
              max={365}
              defaultValue={initial.notifyBeforeDays}
              className={inputCls}
            />
          </Field>
          <Field label="RFP check date" desc="When to revisit the funder's call for proposals.">
            <input type="date" name="checkRfpDate" defaultValue={initial.checkRfpDate ?? ""} className={inputCls} />
          </Field>
        </div>
      </Section>

      <Section title="Links">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Website" desc="Funder or opportunity page.">
            <input name="website" defaultValue={initial.website ?? ""} className={inputCls} />
          </Field>
          <Field label="Folder link" desc="Shared drive folder for this grant.">
            <input name="folderLink" defaultValue={initial.folderLink ?? ""} className={inputCls} />
          </Field>
          <Field label="Budget link" desc="Budget spreadsheet or doc.">
            <input name="budgetLink" defaultValue={initial.budgetLink ?? ""} className={inputCls} />
          </Field>
          <Field label="Proposal link" desc="Proposal document.">
            <input name="proposalLink" defaultValue={initial.proposalLink ?? ""} className={inputCls} />
          </Field>
        </div>
      </Section>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/grants")}
          className="rounded-md border px-4 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
