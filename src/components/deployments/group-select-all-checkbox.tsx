"use client";

import type { Dispatch, SetStateAction } from "react";
import type { RowSelectionState } from "@tanstack/react-table";
import { Checkbox } from "@/components/ui/checkbox";

interface GroupSelectAllCheckboxProps {
  /** Deployment IDs in this group that are currently visible (pass the
   *  filter). Drives the indeterminate/all/none state. */
  groupDeploymentIds: number[];
  rowSelection: RowSelectionState;
  setRowSelection: Dispatch<SetStateAction<RowSelectionState>>;
  groupLabel: string;
}

/**
 * Group-scoped select-all checkbox. Shared between camera-trap and audio
 * instalaciones tables — both group their rows by project and want a
 * group-level toggle that:
 *   - reflects all/some/none-selected state for the group
 *   - is disabled if no rows in the group are visible (filter excluded)
 *   - swallows the click so the group header's collapse/expand isn't triggered
 */
export function GroupSelectAllCheckbox({
  groupDeploymentIds,
  rowSelection,
  setRowSelection,
  groupLabel,
}: GroupSelectAllCheckboxProps) {
  const selectedCount = groupDeploymentIds.filter(
    (id) => rowSelection[String(id)]
  ).length;
  const allSelected =
    groupDeploymentIds.length > 0 && selectedCount === groupDeploymentIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  return (
    <Checkbox
      checked={allSelected || (someSelected && "indeterminate")}
      disabled={groupDeploymentIds.length === 0}
      onClick={(e) => e.stopPropagation()}
      onCheckedChange={(value) => {
        const isChecked = !!value;
        setRowSelection((prev) => {
          const next = { ...prev };
          for (const id of groupDeploymentIds) {
            if (isChecked) next[String(id)] = true;
            else delete next[String(id)];
          }
          return next;
        });
      }}
      aria-label={`Seleccionar todas las instalaciones de ${groupLabel}`}
    />
  );
}
