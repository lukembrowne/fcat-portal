# Verified Empty Deployments

**Date**: 2026-02-15
**Status**: Ready for planning

## What We're Building

A way to mark camera trap deployments as "verified empty" — confirming that a deployment with zero ML detections is legitimately empty (no animals), rather than empty due to an error or oversight. This is ecologically meaningful data: knowing a camera station detected nothing is as important as knowing what it detected.

## Why This Approach

Adding `"verified_empty"` as a new deployment status (alongside `unscanned`, `scanned`, `processing`, `processed`, `verified`):

- Fits naturally into the existing status state machine and UI patterns (StatusBadge, filter dropdowns, status legend)
- Easy to filter and query for reporting ("show me all verified-empty deployments")
- Simple to implement — one new enum value, a button, and a server action
- Alternative (boolean flag) was rejected because it complicates filtering and doesn't integrate as cleanly with the status-based UI

## Key Decisions

1. **New `verified_empty` status** added to the deployment status enum
2. **Editors and Admins only** can mark a deployment as verified empty
3. **Only after processing** — deployment must be `processed` with 0 detections before the button appears
4. **No note required** — just records who verified it and when (existing `updatedAt` field)
5. **Reversible** — re-processing a deployment resets it to `processed`; an explicit undo action also available
6. **Distinct badge color** — visually different from `processed` and `verified` (e.g., teal/slate)

## State Machine Update

```
unscanned → scanned → processing → processed → verified
                                       ↓ (0 detections)
                                  verified_empty
                                       ↕ (undo / re-process)
                                    processed
```

## UI Changes

- **Expanded row**: "Verificar vacío" button appears when status is `processed` and detection count is 0. "Deshacer verificación" appears when status is `verified_empty`.
- **Status badge**: New badge for `verified_empty` — label "Vacía verificada", distinct color
- **Filter dropdown**: Add `verified_empty` option
- **Status legend**: Add explanation for the new status

## Open Questions

None — ready for planning.
