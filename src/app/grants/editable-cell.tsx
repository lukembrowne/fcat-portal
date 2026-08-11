"use client";

/**
 * Grants-flavored inline-edit cells. The interaction mechanics live in the
 * shared `@/components/editable-cell`; this module binds them to the grants
 * defaults — `updateGrantField` as the action, and the English `formatUsd` /
 * `formatDate` helpers from `@/lib/grants/constants`.
 *
 * NOTE: the grant tracking module is intentionally in ENGLISH so it can be
 * shared with English-speaking collaborators. Do not "fix" these strings to
 * Spanish.
 */

import type { GrantStatus } from "@/db/schema";
import { updateGrantField } from "./actions";
import {
  EditableField as BaseEditableField,
  EditableSelect as BaseEditableSelect,
  type FieldAction,
  type Kind,
  type CellFormatters,
} from "@/components/editable-cell";
import {
  formatUsd,
  formatDate,
  GRANT_STATUS_LABELS,
  GRANT_STATUS_COLORS,
  GRANT_STATUS_ORDER,
} from "@/lib/grants/constants";

export type { FieldAction };

/** English money/date rendering — unchanged from before the extraction. */
const GRANT_FORMATTERS: CellFormatters = {
  amount: (v) => formatUsd(v),
  date: (v) =>
    v ? formatDate(new Date(`${v}T00:00:00Z`)) : <span className="text-muted-foreground">—</span>,
};

export function EditableField({
  id,
  field,
  value,
  kind,
  canEdit,
  action = updateGrantField,
  min,
  max,
  placeholder,
  align = "left",
  fullValueOnHover,
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
  fullValueOnHover?: boolean;
}) {
  return (
    <BaseEditableField
      id={id}
      field={field}
      value={value}
      kind={kind}
      canEdit={canEdit}
      action={action}
      formatters={GRANT_FORMATTERS}
      min={min}
      max={max}
      placeholder={placeholder}
      align={align}
      fullValueOnHover={fullValueOnHover}
    />
  );
}

export function EditableSelect({
  id,
  field,
  value,
  options,
  canEdit,
  action = updateGrantField,
  colors,
}: {
  id: number;
  field: string;
  value: string | null;
  options: { value: string; label: string }[];
  canEdit: boolean;
  action?: FieldAction;
  colors?: Record<string, string>;
}) {
  return (
    <BaseEditableSelect
      id={id}
      field={field}
      value={value}
      options={options}
      canEdit={canEdit}
      action={action}
      colors={colors}
    />
  );
}

/**
 * Grant status cell — the shared select bound to the pipeline's own ordering,
 * with no empty choice (a grant always has a status). Goes through the same
 * `useFieldSave` path as every other cell, so a status change still triggers
 * `router.refresh()` and re-syncs the summary cards and urgency badge.
 */
const GRANT_STATUS_OPTIONS = GRANT_STATUS_ORDER.map((s) => ({
  value: s,
  label: GRANT_STATUS_LABELS[s],
}));

export function EditableStatus({
  grantId,
  value,
  canEdit,
}: {
  grantId: number;
  value: GrantStatus;
  canEdit: boolean;
}) {
  return (
    <BaseEditableSelect
      id={grantId}
      field="status"
      value={value}
      options={GRANT_STATUS_OPTIONS}
      canEdit={canEdit}
      action={updateGrantField}
      colors={GRANT_STATUS_COLORS}
      allowEmpty={false}
    />
  );
}
