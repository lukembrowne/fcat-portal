"use client";

/**
 * Live editable table cells for the /grants table. A cell shows its formatted
 * value (badge, $50,000, "Aug 1, 2026"); clicking it (editors only) swaps to the
 * matching input. Blur or Enter saves; Escape reverts. Each save is one per-field
 * write via `updateGrantField`, with an optimistic in-cell update plus
 * `router.refresh()` to re-sync derived UI (summary cards, urgency badge).
 *
 * Cells format themselves from PRIMITIVE props (string/number/null) using the
 * client-safe helpers in `@/lib/grants/constants` — we never pass a pre-rendered
 * badge/element and try to re-derive it (Server→Client serialization trap).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { GrantStatus } from "@/db/schema";
import type { ActionResult } from "@/lib/types";
import { updateGrantField } from "./actions";
import {
  formatUsd,
  formatDate,
  GRANT_STATUS_LABELS,
  GRANT_STATUS_COLORS,
  GRANT_STATUS_ORDER,
} from "@/lib/grants/constants";

type Kind = "text" | "amount" | "number" | "date" | "textarea";

/**
 * The shape every inline-edit server action shares: take (id, field, raw) and
 * return the canonical stored value. `updateGrantField` (grants) and
 * `updateFunderField` (funders) both satisfy it, so the same cells edit either
 * table — pass the matching `action` (default: grants).
 */
export type FieldAction = (
  id: number,
  field: string,
  raw: string | null
) => Promise<ActionResult<{ field: string; value: string | number | null }>>;

/** Shared save logic: optimistic value + transition + router.refresh on success. */
function useFieldSave<T extends string | number | null>(
  id: number,
  field: string,
  value: T,
  action: FieldAction = updateGrantField
) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [optimistic, setOptimistic] = useState<T | undefined>(undefined);
  const [lastValue, setLastValue] = useState(value);

  // When the server prop catches up after router.refresh(), drop the override.
  // (Render-time state adjustment — React's recommended alternative to an effect.)
  if (value !== lastValue) {
    setLastValue(value);
    setOptimistic(undefined);
  }

  const shown = (optimistic !== undefined ? optimistic : value) as T;

  function save(raw: string | null, onSaved?: () => void) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await action(id, field, raw);
      if (res.success) {
        setOptimistic(res.data.value as T);
        setSaved(true);
        onSaved?.();
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return { shown, save, pending, error, saved, clearSaved: () => setSaved(false) };
}

/** Convert the canonical value to the string an <input> should start with. */
function toEditString(value: string | number | null): string {
  if (value == null) return "";
  return String(value);
}

/** Render the formatted display for a non-status field. */
function display(value: string | number | null, kind: Kind): React.ReactNode {
  if (kind === "amount") return formatUsd(value == null ? null : Number(value));
  if (kind === "date") {
    return value ? formatDate(new Date(`${value}T00:00:00Z`)) : <span className="text-muted-foreground">—</span>;
  }
  if (value == null || value === "") return <span className="text-muted-foreground">—</span>;
  return String(value);
}

export function EditableField({
  id,
  field,
  value,
  kind,
  canEdit,
  action,
  min,
  max,
  placeholder,
  align = "left",
}: {
  id: number;
  field: string;
  value: string | number | null;
  kind: Kind;
  canEdit: boolean;
  action?: FieldAction;
  min?: number;
  max?: number;
  placeholder?: string;
  align?: "left" | "right";
}) {
  const { shown, save, pending, error, saved, clearSaved } = useFieldSave(id, field, value, action);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const alignCls = align === "right" ? "text-right tabular-nums" : "";

  function beginEdit() {
    if (!canEdit) return;
    clearSaved();
    setDraft(toEditString(shown));
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    if (draft === toEditString(shown)) return; // unchanged
    save(draft.trim() === "" ? null : draft, () => {});
  }

  function cancel() {
    setEditing(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && kind !== "textarea") {
      e.preventDefault();
      (e.currentTarget as HTMLElement).blur();
    } else if (e.key === "Enter" && kind === "textarea" && !e.shiftKey) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).blur();
    }
  }

  // Read-only (viewer) — just the formatted value, no affordance.
  if (!canEdit) {
    return <span className={alignCls}>{display(shown, kind)}</span>;
  }

  if (editing) {
    const common = {
      autoFocus: true,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown,
      placeholder,
      className: `w-full rounded border bg-white px-1.5 py-1 text-sm ${align === "right" ? "text-right" : ""}`,
    };
    if (kind === "textarea") {
      return <textarea {...common} rows={3} className={`${common.className} min-w-[220px] whitespace-pre-wrap`} />;
    }
    const type = kind === "date" ? "date" : kind === "number" ? "number" : "text";
    const inputMode = kind === "amount" ? "decimal" : undefined;
    return <input {...common} type={type} inputMode={inputMode} min={min} max={max} />;
  }

  return (
    <button
      type="button"
      onClick={beginEdit}
      title="Click to edit"
      className={`group/edit -mx-1 inline-flex w-[calc(100%+0.5rem)] items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted/60 ${alignCls} ${align === "right" ? "justify-end" : ""}`}
    >
      <span className={kind === "textarea" ? "line-clamp-2 whitespace-pre-wrap text-sm" : "truncate"}>
        {display(shown, kind)}
      </span>
      {pending && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
      {saved && !pending && <Check className="h-3 w-3 shrink-0 text-green-600" />}
      {error && (
        <span className="shrink-0 text-xs text-red-600" title={error}>
          !
        </span>
      )}
    </button>
  );
}

export function EditableStatus({
  grantId,
  value,
  canEdit,
}: {
  grantId: number;
  value: GrantStatus;
  canEdit: boolean;
}) {
  const { shown, save, pending, error } = useFieldSave<GrantStatus>(grantId, "status", value);
  const [editing, setEditing] = useState(false);

  if (!canEdit) {
    return (
      <Badge variant="secondary" className={GRANT_STATUS_COLORS[shown]}>
        {GRANT_STATUS_LABELS[shown]}
      </Badge>
    );
  }

  if (editing) {
    return (
      <select
        autoFocus
        defaultValue={shown}
        onBlur={() => setEditing(false)}
        onChange={(e) => {
          const next = e.target.value as GrantStatus;
          setEditing(false);
          if (next !== shown) save(next);
        }}
        className="rounded border bg-white px-1.5 py-1 text-sm"
      >
        {GRANT_STATUS_ORDER.map((s) => (
          <option key={s} value={s}>
            {GRANT_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={error ?? "Click to change status"}
      className="inline-flex items-center gap-1 rounded hover:opacity-80"
    >
      <Badge variant="secondary" className={GRANT_STATUS_COLORS[shown]}>
        {GRANT_STATUS_LABELS[shown]}
      </Badge>
      {pending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      {error && <span className="text-xs text-red-600">!</span>}
    </button>
  );
}

/**
 * Generic nullable-enum cell. Display shows a badge with the option's label (or
 * "—" when unset); clicking it (editors only) swaps to a <select> with a
 * "— none —" choice. Selecting saves immediately via the passed `action`.
 * Used for the funder `priority` column.
 */
export function EditableSelect({
  id,
  field,
  value,
  options,
  canEdit,
  action,
  colors,
}: {
  id: number;
  field: string;
  value: string | null;
  options: { value: string; label: string }[];
  canEdit: boolean;
  action?: FieldAction;
  /** Optional per-value badge color classes (e.g. funder priority levels). */
  colors?: Record<string, string>;
}) {
  const { shown, save, pending, error } = useFieldSave<string | null>(id, field, value, action);
  const [editing, setEditing] = useState(false);

  const label = options.find((o) => o.value === shown)?.label ?? null;
  const badge = label ? (
    <Badge variant="secondary" className={shown ? colors?.[shown] : undefined}>
      {label}
    </Badge>
  ) : (
    <span className="text-muted-foreground">—</span>
  );

  if (!canEdit) return badge;

  if (editing) {
    return (
      <select
        autoFocus
        defaultValue={shown ?? ""}
        onBlur={() => setEditing(false)}
        onChange={(e) => {
          const next = e.target.value === "" ? null : e.target.value;
          setEditing(false);
          if (next !== shown) save(next);
        }}
        className="rounded border bg-white px-1.5 py-1 text-sm"
      >
        <option value="">— none —</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={error ?? "Click to edit"}
      className="inline-flex items-center gap-1 rounded hover:opacity-80"
    >
      {badge}
      {pending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      {error && <span className="text-xs text-red-600">!</span>}
    </button>
  );
}
