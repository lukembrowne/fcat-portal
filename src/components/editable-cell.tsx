"use client";

/**
 * Live editable table cells, shared by /grants, /grants/funders and
 * /finance/sueldos. A cell shows its formatted value; clicking it (editors only)
 * swaps to the matching input. Blur or Enter saves; Escape reverts. Each save is
 * one per-field write through the passed `action`, with an optimistic in-cell
 * update plus `router.refresh()` to re-sync derived UI (summary cards, totals).
 *
 * Cells format themselves from PRIMITIVE props (string/number/null) — never pass
 * a pre-rendered badge or element from a Server Component and try to re-derive
 * it (Server→Client serialization trap).
 *
 * Display formatting is injected rather than imported, because the two callers
 * format differently: /grants is English (`$50,000`, "Aug 1, 2026"), /finance is
 * Spanish (`$50,000.00`, "1 ago 2026").
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ActionResult } from "@/lib/types";

export type Kind = "text" | "amount" | "number" | "date" | "textarea";

/**
 * The shape every inline-edit server action shares: take (id, field, raw) and
 * return the canonical stored value. `updateGrantField`, `updateFunderField`,
 * `updatePersonField`, `updateSourceField`, `updateAllocationField` and
 * `updateSalaryForYear` all satisfy it, so the same cells edit any of them.
 */
export type FieldAction = (
  id: number,
  field: string,
  raw: string | null
) => Promise<ActionResult<{ field: string; value: string | number | null }>>;

/** Per-call display formatting. Both default to a plain string render. */
export interface CellFormatters {
  amount?: (v: number | null) => React.ReactNode;
  /** Receives the raw stored value, e.g. "2026-08-01". */
  date?: (v: string | null) => React.ReactNode;
}

/** Shared save logic: optimistic value + transition + router.refresh on success. */
function useFieldSave<T extends string | number | null>(
  id: number,
  field: string,
  value: T,
  action: FieldAction
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

function defaultDisplay(
  value: string | number | null,
  kind: Kind,
  formatters?: CellFormatters
): React.ReactNode {
  if (kind === "amount") {
    const n = value == null ? null : Number(value);
    return formatters?.amount ? formatters.amount(n) : n == null ? "—" : String(n);
  }
  if (kind === "date") {
    const s = value == null || value === "" ? null : String(value);
    if (formatters?.date) return formatters.date(s);
    return s ?? <span className="text-muted-foreground">—</span>;
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
  formatters,
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
  action: FieldAction;
  formatters?: CellFormatters;
  min?: number;
  max?: number;
  placeholder?: string;
  align?: "left" | "right";
}) {
  const { shown, save, pending, error, saved, clearSaved } = useFieldSave(
    id,
    field,
    value,
    action
  );
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
    return <span className={alignCls}>{defaultDisplay(shown, kind, formatters)}</span>;
  }

  if (editing) {
    const common = {
      autoFocus: true,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft(e.target.value),
      onBlur: commit,
      onKeyDown,
      placeholder,
      className: `w-full rounded border bg-white px-1.5 py-1 text-sm dark:bg-background ${
        align === "right" ? "text-right" : ""
      }`,
    };
    if (kind === "textarea") {
      return (
        <textarea
          {...common}
          rows={3}
          className={`${common.className} min-w-[220px] whitespace-pre-wrap`}
        />
      );
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
      className={`group/edit -mx-1 inline-flex w-[calc(100%+0.5rem)] items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted/60 ${alignCls} ${
        align === "right" ? "justify-end" : ""
      }`}
    >
      <span className={kind === "textarea" ? "line-clamp-2 whitespace-pre-wrap text-sm" : "truncate"}>
        {defaultDisplay(shown, kind, formatters)}
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

/**
 * Generic enum cell. Display shows a badge with the option's label (or "—" when
 * unset); clicking it (editors only) swaps to a <select>. Selecting saves
 * immediately. `allowEmpty` adds a "none" choice for nullable columns.
 */
export function EditableSelect({
  id,
  field,
  value,
  options,
  canEdit,
  action,
  colors,
  allowEmpty = true,
  emptyLabel = "— none —",
}: {
  id: number;
  field: string;
  value: string | null;
  options: { value: string; label: string }[];
  canEdit: boolean;
  action: FieldAction;
  /** Optional per-value badge color classes. */
  colors?: Record<string, string>;
  allowEmpty?: boolean;
  emptyLabel?: string;
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
        className="rounded border bg-white px-1.5 py-1 text-sm dark:bg-background"
      >
        {allowEmpty && <option value="">{emptyLabel}</option>}
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
