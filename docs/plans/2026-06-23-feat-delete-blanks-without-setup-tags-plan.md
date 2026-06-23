---
title: Allow deleting blank images without designated setup tags (extra confirmation)
type: feat
date: 2026-06-23
---

# ✨ Allow deleting blank images without designated instalación/recogida

## Overview

In the camera-trap results view, the **"Eliminar imágenes vacías"** dialog currently
**blocks** bulk deletion of blank images until the user has designated the
*instalación* (deployment) and *recogida* (retrieval) images. The "Siguiente" button is
disabled and an amber warning reads *"Debe designar las imágenes de instalación y
recogida antes de eliminar."*

We want to **un-block** this: the user should still be able to delete blanks even when
the setup/retrieval images haven't been designated — but when they haven't, the dialog
must present an **additional, explicit confirmation** (acknowledging the risk) before the
destructive action proceeds.

This is a focused, single-file UI change. The destructive server action already imposes
**no** setup-tag requirement (the block is purely client-side), so no server change is
strictly required for the happy path.

## Problem Statement / Motivation

- Designating instalación/recogida is a separate, sometimes-skipped step. Today a hard
  block forces users to do it first, even when they just want to clean up obvious blanks.
- Why the guard exists in the first place: images tagged `deployment`/`retrieval` are
  **excluded** from bulk deletion (defensive filter in `computeEligibilitySets`,
  `src/app/camera-trap/actions.ts`). The install/retrieval frames are frequently *blank*
  themselves (camera pointing at a person setting up, or an empty scene). If they haven't
  been designated, those frames are eligible for deletion under "Imágenes sin detecciones"
  / "Imágenes confirmadas vacías", and once trashed the user loses the frames that anchor
  the deployment's `validStart` / `validEnd` window.
- So the right behavior is **"allow, but make them consciously accept the consequence"** —
  exactly what the user asked for: *"maybe just pop up with an additional confirmation when
  they haven't been set."*

## Proposed Solution

Keep the existing 3-step dialog (`select → confirm → result`). Make two changes:

1. **Remove the hard gate on "Siguiente"** in the `select` step. The button is no longer
   disabled by `!tagsReady`; it remains disabled only by the existing `noneSelected` /
   `totalCount === 0` / `isPending` conditions.
2. **Add an explicit acknowledgment on the `confirm` step** that appears *only when
   setup/retrieval tags are missing*:
   - A prominent amber warning explaining what's missing (reuse the existing
     "Falta: instalación y recogida" specificity) and why it matters (those frames may be
     deleted).
   - An acknowledgment checkbox: *"Entiendo que no he designado las imágenes de instalación
     y recogida, y que podrían eliminarse."*
   - The destructive **"Confirmar eliminación"** button stays disabled until the checkbox
     is ticked (only when tags are missing; when tags are present, the flow is unchanged).

Also **soften the `select`-step warning copy** from an imperative block
("Debe designar … antes de eliminar") to a caution ("No ha designado las imágenes de
instalación y recogida"), since it's no longer a blocker.

### Updated step / gating flow

```
select  ──"Siguiente" (no longer gated by tags)──▶  confirm  ──"Confirmar eliminación"──▶ result
                                                      │
                                          if tags missing: must tick
                                          acknowledgment checkbox first
```

## Technical Considerations

- **Single file:** `src/app/camera-trap/results/[id]/bulk-delete-blanks-dialog.tsx`.
  All state already lives here; `setupTags` (`{ hasDeployment, hasRetrieval }`) is already
  fetched on mount via `checkSetupRetrievalTags(jobId)`.
- **Loading race:** `setupTags` is `null` until `checkSetupRetrievalTags` resolves. Today
  the disabled "Siguiente" masked this. After removing the gate, a user could reach the
  `confirm` step before tags load. Gate the *confirm* button on a loaded value:
  - `tagsLoaded = setupTags !== null`
  - `tagsReady = setupTags?.hasDeployment && setupTags?.hasRetrieval`
  - Confirm button: `disabled={isPending || !tagsLoaded || (!tagsReady && !ackMissingTags)}`
  - This treats "still loading" as not-yet-confirmable (brief), and "loaded + missing" as
    requiring the acknowledgment.
- **Reset acknowledgment on "Volver":** if the user goes back to `select` and changes the
  selection, reset `ackMissingTags` to `false` so a stale acceptance can't carry forward.
- **Partial designation:** one tag present, the other missing (e.g. has `deployment`, no
  `retrieval`) still counts as `!tagsReady` → acknowledgment required. Reuse the existing
  "Falta: instalación" / "Falta: recogida" / "Falta: instalación y recogida" text.
- **Permissions unchanged:** all three server actions already call
  `requirePermission("camera-trap", "admin")`. No change.
- **Server-side guard (optional hardening — see Decisions):** the deletion is currently
  UI-gated only. If we want defense-in-depth, add an explicit
  `acknowledgeMissingSetupTags?: boolean` param to `bulkDeleteBlankImages`; when setup tags
  are missing and the flag is falsy, return an `ActionResult` error. The defensive
  `computeEligibilitySets` filter already prevents *tagged* images from being deleted, so
  this is about preventing a *silent programmatic bypass*, not data loss of designated
  frames. Default for MVP: **UI-only**, matching the user's "just pop up a confirmation."

## Acceptance Criteria

- [x] In the `select` step, **"Siguiente" is enabled** even when instalación/recogida are
      not designated (subject only to a non-empty, valid selection).
- [x] The `select`-step warning still appears when tags are missing, but reworded as a
      caution (not "Debe … antes de eliminar").
- [x] In the `confirm` step, when tags are missing, an amber warning + acknowledgment
      checkbox appear, and **"Confirmar eliminación" is disabled until the box is ticked.**
- [x] When **both** tags are designated, the `confirm` step shows **no** extra checkbox and
      behaves exactly as today.
- [x] The acknowledgment-specific copy reflects which tag(s) are missing (instalación /
      recogida / both).
- [x] Going back to `select` and returning resets the acknowledgment (must re-tick).
- [x] Deletion still excludes any image carrying a `setupTag` (no regression to the
      defensive filter — server action unchanged, verified by reading).
- [ ] No layout regressions in the dialog (per CLAUDE.md UI rule): the added warning +
      checkbox fit the `sm:max-w-md` dialog without overflow. _(manual visual check pending)_
- [x] `npm run lint` passes; `tsc` clean on the edited file (no new type errors).

## Dependencies & Risks

- **Risk:** users delete the actual install/retrieval frames. Mitigated by the explicit
  acknowledgment (the whole point) — images are trashed to Drive and **recoverable for 30
  days** (already stated in the confirm step), so it's reversible.
- **Risk:** the loading-race window (`setupTags === null`) lets a user click through before
  tags resolve. Mitigated by gating the *confirm* button on `tagsLoaded`.
- **No DB / schema / migration changes.** No new job types, so no
  `JOB_LABELS`/`AUDIO_JOB_TYPES` coverage-guard impact.

## MVP — concrete edits

All in `src/app/camera-trap/results/[id]/bulk-delete-blanks-dialog.tsx`.

### bulk-delete-blanks-dialog.tsx — new state + derived flags

```tsx
// add alongside the other useState hooks (~line 57)
const [ackMissingTags, setAckMissingTags] = useState(false);

// derived flags (~line 98)
const tagsLoaded = setupTags !== null;
const tagsReady = setupTags?.hasDeployment && setupTags?.hasRetrieval;

// helper for the "Falta: …" line, reused in both steps
const missingTagsLabel =
  setupTags && !tagsReady
    ? !setupTags.hasDeployment && !setupTags.hasRetrieval
      ? "instalación y recogida"
      : !setupTags.hasDeployment
        ? "instalación"
        : "recogida"
    : null;
```

### bulk-delete-blanks-dialog.tsx — un-gate "Siguiente" (~line 285)

```tsx
// before:
disabled={isPending || noneSelected || totalCount === 0 || !tagsReady}
// after:
disabled={isPending || noneSelected || totalCount === 0}
```

### bulk-delete-blanks-dialog.tsx — soften the select-step warning (~lines 165–179)

```tsx
{setupTags && !tagsReady && (
  <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
    <AlertTriangle className="size-4 mt-0.5 shrink-0" />
    <div>
      <p className="font-medium">No ha designado las imágenes de instalación y recogida.</p>
      <p className="text-xs mt-1">
        Falta: {missingTagsLabel}. Podrá continuar, pero se le pedirá una confirmación
        adicional.
      </p>
    </div>
  </div>
)}
```

### bulk-delete-blanks-dialog.tsx — confirm-step acknowledgment (inside the `step === "confirm"` block, ~after line 157)

```tsx
{tagsLoaded && !tagsReady && (
  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2 text-sm text-amber-800">
    <div className="flex items-start gap-2">
      <AlertTriangle className="size-4 mt-0.5 shrink-0" />
      <p className="font-medium">
        No se han designado las imágenes de instalación/recogida (falta: {missingTagsLabel}).
        Las imágenes de instalación o recogida podrían eliminarse.
      </p>
    </div>
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={ackMissingTags}
        onChange={(e) => setAckMissingTags(e.target.checked)}
        className="accent-primary"
      />
      <span className="text-xs">
        Entiendo y quiero eliminar de todos modos.
      </span>
    </label>
  </div>
)}
```

### bulk-delete-blanks-dialog.tsx — gate the destructive button (~line 300) + reset on "Volver" (~line 295)

```tsx
// "Volver" handler — also reset the acknowledgment
onClick={() => { setStep("select"); setError(null); setAckMissingTags(false); }}

// "Confirmar eliminación" button
disabled={isPending || !tagsLoaded || (!tagsReady && !ackMissingTags)}
```

### (Optional) server-side hardening — actions.ts

```ts
// bulkDeleteBlankImages(jobId, scope, opts?: { acknowledgeMissingSetupTags?: boolean })
// after requirePermission, before computeEligibilitySets:
const { hasDeployment, hasRetrieval } = /* same query as checkSetupRetrievalTags */;
if ((!hasDeployment || !hasRetrieval) && !opts?.acknowledgeMissingSetupTags) {
  return { success: false, error: "Debe confirmar la eliminación sin imágenes de instalación/recogida designadas." };
}
```

## Decisions (resolved)

1. **Acknowledgment UX** — ✅ single checkbox on the existing `confirm` step (one file, no
   new step).
2. **Server-side enforcement** — ✅ **UI-only.** Do not change `bulkDeleteBlankImages`. The
   server action is already `requirePermission("camera-trap", "admin")`-gated and its
   `computeEligibilitySets` defensive filter already excludes any `setupTag` image, so no
   designated frame can be deleted regardless. (The optional `acknowledgeMissingSetupTags`
   server param above is **out of scope** for this change.)

## References & Research

### Internal
- Dialog component (all UI edits): `src/app/camera-trap/results/[id]/bulk-delete-blanks-dialog.tsx`
  - select-step warning: lines 165–179
  - "Siguiente" disable: line 285
  - confirm step: lines 131–162
  - destructive button: lines 300–308
  - `tagsReady` derivation: line 98; `setupTags` fetch: lines 60–73
- Server actions: `src/app/camera-trap/actions.ts`
  - `checkSetupRetrievalTags` (lines ~2337–2360) — source of `hasDeployment`/`hasRetrieval`
  - `countDeletableImages` (lines ~2500–2540)
  - `bulkDeleteBlankImages` (lines ~2542–2690) — **no setup-tag guard today**
  - `computeEligibilitySets` (lines ~2385–2387) — defensive filter excluding `setupTag` images
  - `toggleSetupTag` (lines ~5478–5546) — how instalación/recogida are designated
- Data model: `src/db/schema.ts` line ~308 — `setupTag: text("setup_tag")` (`'deployment' | 'retrieval' | null`)
- Dialog open point: `src/app/camera-trap/deployment-actions-menu.tsx` (~line 518 menu item, ~621 render)

### Related brainstorms (context, not this feature)
- `docs/brainstorms/2026-02-17-blank-image-confirmation-brainstorm.md` — per-image `b`-key "confirmed blank" mechanism (the `confirmedBlank` source).
- `docs/brainstorms/2026-02-15-verified-empty-deployments-brainstorm.md` — deployment-level `verified_empty`.

### Conventions applied (CLAUDE.md)
- Spanish UI strings (hardcoded).
- `ActionResult<T>` for any server-action change.
- Verify no dialog layout regression after the change.
- Destructive admin action already permission-gated; instrumentation via `recordEvent()` is
  optional here (no new job type).
