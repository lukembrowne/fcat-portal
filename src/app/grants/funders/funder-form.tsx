"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { saveFunder } from "./actions";
import type { FunderPriority } from "@/db/schema";
import { funderPriorityEnum } from "@/db/schema";
import { FUNDER_PRIORITY_LABELS } from "@/lib/grants/constants";

export interface FunderFormInitial {
  id?: number;
  name: string;
  website: string | null;
  priority: FunderPriority | null;
  funderType: string | null;
  focusAreas: string | null;
  relationshipManager: string | null;
  relationshipStatus: string | null;
  nextSteps: string | null;
  nextStepDue: string | null; // YYYY-MM-DD
  contactName: string | null;
  contactEmail: string | null;
  fundingHistory: string | null;
  description: string | null;
  notes: string | null;
  irs990Link: string | null;
  guidestarLink: string | null;
  foundationDirectoryLink: string | null;
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

export function FunderForm({ initial }: { initial: FunderFormInitial }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(saveFunder, null);

  useEffect(() => {
    if (state?.success) {
      router.push(`/grants/funders/${state.data.id}`);
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

      <Section title="Funder">
        <Field label="Name *" desc="Funder or foundation name (must be unique).">
          <input name="name" required defaultValue={initial.name} className={inputCls} />
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Priority" desc="How actively we're pursuing this funder.">
            <select name="priority" defaultValue={initial.priority ?? ""} className={inputCls}>
              <option value="">—</option>
              {funderPriorityEnum.map((p) => (
                <option key={p} value={p}>
                  {FUNDER_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type" desc="E.g. private foundation, government, corporate.">
            <input name="funderType" defaultValue={initial.funderType ?? ""} className={inputCls} />
          </Field>
          <Field label="Website" desc="Funder's main website.">
            <input name="website" defaultValue={initial.website ?? ""} className={inputCls} />
          </Field>
        </div>
      </Section>

      <Section title="Relationship">
        <div className="grid grid-cols-3 gap-4">
          <Field label="Relationship manager" desc="Who at FCAT owns this relationship.">
            <input name="relationshipManager" defaultValue={initial.relationshipManager ?? ""} className={inputCls} />
          </Field>
          <Field label="Relationship status" desc="E.g. prospect, contacted, active.">
            <input name="relationshipStatus" defaultValue={initial.relationshipStatus ?? ""} className={inputCls} />
          </Field>
          <Field label="Next step due" desc="When the next action is due.">
            <input type="date" name="nextStepDue" defaultValue={initial.nextStepDue ?? ""} className={inputCls} />
          </Field>
        </div>

        <Field label="Next steps" desc="The next action to take with this funder.">
          <textarea name="nextSteps" rows={2} defaultValue={initial.nextSteps ?? ""} className={inputCls} />
        </Field>
      </Section>

      <Section title="Contact">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Contact name" desc="Primary contact at the funder.">
            <input name="contactName" defaultValue={initial.contactName ?? ""} className={inputCls} />
          </Field>
          <Field label="Contact email" desc="Primary contact's email.">
            <input name="contactEmail" type="email" defaultValue={initial.contactEmail ?? ""} className={inputCls} />
          </Field>
        </div>
      </Section>

      <Section title="Background">
        <Field label="Focus areas" desc="Themes or programs this funder supports.">
          <input name="focusAreas" defaultValue={initial.focusAreas ?? ""} className={inputCls} />
        </Field>
        <Field label="Funding history" desc="Past grants or relationship history.">
          <textarea name="fundingHistory" rows={2} defaultValue={initial.fundingHistory ?? ""} className={inputCls} />
        </Field>
        <Field label="Description" desc="What the funder does and its priorities.">
          <textarea name="description" rows={3} defaultValue={initial.description ?? ""} className={inputCls} />
        </Field>
        <Field label="Notes" desc="Internal notes and reminders.">
          <textarea name="notes" rows={2} defaultValue={initial.notes ?? ""} className={inputCls} />
        </Field>
      </Section>

      <Section title="Due-diligence links">
        <div className="grid grid-cols-3 gap-4">
          <Field label="IRS 990" desc="Due-diligence link.">
            <input name="irs990Link" defaultValue={initial.irs990Link ?? ""} className={inputCls} />
          </Field>
          <Field label="GuideStar" desc="Due-diligence link.">
            <input name="guidestarLink" defaultValue={initial.guidestarLink ?? ""} className={inputCls} />
          </Field>
          <Field label="Foundation Directory" desc="Due-diligence link.">
            <input name="foundationDirectoryLink" defaultValue={initial.foundationDirectoryLink ?? ""} className={inputCls} />
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
          onClick={() => router.push("/grants/funders")}
          className="rounded-md border px-4 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
