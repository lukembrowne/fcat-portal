"use client";

/**
 * Links cell for the /grants table. Display mode shows the labeled icon pills
 * (Website / Folder / Budget / Proposal). Editors get a pencil that expands an
 * INLINE editor inside the cell (not a popup) with one URL input per link; each
 * saves on blur via `updateGrantField`.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe, Folder, Calculator, FileText, Pencil, Check, Loader2 } from "lucide-react";
import { updateGrantField } from "./actions";
import { type EditableGrantField } from "@/lib/grants/constants";

const LINK_META = {
  website: { label: "Website", icon: Globe },
  folderLink: { label: "Folder", icon: Folder },
  budgetLink: { label: "Budget", icon: Calculator },
  proposalLink: { label: "Proposal", icon: FileText },
} as const;

type LinkField = keyof typeof LINK_META;
const LINK_FIELDS = Object.keys(LINK_META) as LinkField[];

export interface GrantLinks {
  website: string | null;
  folderLink: string | null;
  budgetLink: string | null;
  proposalLink: string | null;
}

function LinkInput({
  grantId,
  field,
  value,
}: {
  grantId: number;
  field: LinkField;
  value: string | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(value ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { label, icon: Icon } = LINK_META[field];

  function commit() {
    const next = draft.trim();
    if (next === (value ?? "")) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await updateGrantField(grantId, field as EditableGrantField, next === "" ? null : next);
      if (res.success) {
        setSaved(true);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="inline-flex w-20 shrink-0 items-center gap-1 text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      <input
        type="url"
        value={draft}
        placeholder="https://…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="flex-1 rounded border bg-white px-1.5 py-1 text-xs"
      />
      {pending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      {saved && !pending && <Check className="h-3 w-3 text-green-600" />}
      {error && <span className="text-red-600" title={error}>!</span>}
    </label>
  );
}

export function EditableLinks({
  grantId,
  links,
  canEdit,
}: {
  grantId: number;
  links: GrantLinks;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="relative z-10 flex min-w-[260px] flex-col gap-1.5">
        {LINK_FIELDS.map((f) => (
          <LinkInput key={f} grantId={grantId} field={f} value={links[f]} />
        ))}
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="self-end rounded border px-2 py-0.5 text-xs hover:bg-muted"
        >
          Done
        </button>
      </div>
    );
  }

  const present = LINK_FIELDS.filter((f) => links[f]);

  return (
    <div className="relative z-10 flex flex-wrap items-center gap-1">
      {present.length === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        present.map((f) => {
          const { label, icon: Icon } = LINK_META[f];
          return (
            <a
              key={f}
              href={links[f]!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground whitespace-nowrap"
            >
              <Icon className="h-3 w-3" />
              {label}
            </a>
          );
        })
      )}
      {canEdit && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Edit links"
          className="inline-flex items-center rounded border px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
