---
title: "feat: Per-Image Blank Confirmation"
type: feat
date: 2026-02-17
---

# feat: Per-Image Blank Confirmation

## Overview

Add a per-image "confirmed blank" mechanism to the camera trap annotation workflow. Researchers press `b` to toggle an image as confirmed blank (no wildlife), creating a tracked record that a human reviewed it. When marking blank on an image with detections, all identifications are force-rejected.

## Problem Statement

Currently, blank images (0 ML detections) show a "Vacía" badge but there's no record of whether a human actually reviewed and confirmed the image is blank. The existing `verified_empty` status only operates at the deployment level. Researchers need per-image confirmation for data quality and confidence that the ML pipeline didn't miss anything.

## Proposed Solution

Add a `confirmed_blank` boolean column to the `images` table. Wire up a `b` keyboard shortcut in the annotation page that toggles this flag via a server action. When toggling ON with existing detections, batch-reject all identifications. When a manual detection is drawn on a confirmed-blank image, auto-clear the flag.

## Acceptance Criteria

- [x] `b` key toggles `confirmed_blank` on any processed/failed image
- [x] Toggling ON force-rejects ALL identifications (regardless of current verification status)
- [x] Toggling OFF leaves rejections in place (does not reverse them)
- [x] Drawing a manual detection on a confirmed-blank image auto-clears `confirmed_blank`
- [x] Image grid shows upgraded badge for confirmed-blank images
- [x] Annotation page shows visual indicator when image is confirmed blank
- [x] Help panel documents the `b` shortcut
- [x] `b` shortcut is suppressed when search input is focused, dialog is open, or drawing a bbox
- [x] Action requires editor permission
- [x] Schema migration works on existing databases (ALTER TABLE in push-schema.mjs)

## Technical Approach

### Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `src/db/schema.ts:~193` | Add `confirmedBlank` column to `images` table |
| 2 | `scripts/push-schema.mjs:~355` | Add ALTER TABLE migration + update CREATE TABLE |
| 3 | `src/app/camera-trap/actions.ts` | Add `toggleConfirmedBlank` server action; update `createManualDetection` to auto-clear |
| 4 | `src/hooks/use-annotation-shortcuts.ts:5-14,16-31` | Add `b` shortcut entry, callback option, key handler |
| 5 | `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx:125-136` | Pass `confirmedBlank` prop to client component |
| 6 | `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx:48-59,286-319` | Add prop, handler, wire up shortcut + dialog guard |
| 7 | `src/components/detection-card-strip.tsx:44-49` | Show confirmed-blank indicator |
| 8 | `src/components/image-grid.tsx:7-23,168-174` | Add `confirmedBlank` to interface, render badge |
| 9 | `src/app/camera-trap/results/[id]/page.tsx:112-135` | Include `confirmedBlank` in `gridImages` mapping |
| 10 | `src/components/annotation-help-panel.tsx:~71` | Add `b` shortcut documentation row |

### Implementation Steps

#### Step 1: Schema — Add `confirmedBlank` column

**`src/db/schema.ts`** — Add after `frameIndex` field (~line 193):

```typescript
confirmedBlank: integer("confirmed_blank", { mode: "boolean" })
  .notNull()
  .default(false),
```

**`scripts/push-schema.mjs`** — Add to migrations array (~line 355):

```javascript
`ALTER TABLE biochoco_images ADD COLUMN confirmed_blank INTEGER NOT NULL DEFAULT 0`,
```

Also update the CREATE TABLE for `biochoco_images` (~line 107) to include:

```sql
confirmed_blank INTEGER NOT NULL DEFAULT 0
```

The `Image` type is inferred (`typeof images.$inferSelect`), so it auto-updates.

#### Step 2: Server Action — `toggleConfirmedBlank`

**`src/app/camera-trap/actions.ts`** — New exported action:

```typescript
export async function toggleConfirmedBlank(
  imageId: number
): Promise<ActionResult<{ confirmedBlank: boolean; rejectedCount: number }>> {
  await requirePermission("camera-trap", "editor");
  // 1. Fetch image, validate exists and status is "processed" or "failed"
  // 2. Read current confirmed_blank value
  // 3. In a transaction:
  //    a. Toggle confirmed_blank
  //    b. If toggling ON: batch-reject ALL identifications for all detections on this image
  //       UPDATE identifications SET verificationStatus = 'rejected'
  //       WHERE detectionId IN (SELECT id FROM detections WHERE imageId = ?)
  //       AND verificationStatus != 'rejected'
  // 4. revalidatePath(CAMERA_TRAP_PATH)
  // 5. Return { confirmedBlank: newValue, rejectedCount }
}
```

Key details:
- Use `db.transaction()` to wrap the toggle + batch rejection atomically
- Force-reject ALL identifications (including verified/corrected) — not just unverified
- Return the new state so client can update optimistically
- Reject "pending" images (no image data to review), allow "failed" images

**Also update `createManualDetection`** (~line 2415): After creating the detection, if the image has `confirmedBlank === true`, set it to `false`:

```typescript
// Auto-clear confirmed blank when adding a manual detection
await tx.update(images)
  .set({ confirmedBlank: false })
  .where(and(eq(images.id, imageId), eq(images.confirmedBlank, true)));
```

#### Step 3: Keyboard Shortcut — Add `b` key

**`src/hooks/use-annotation-shortcuts.ts`**:

1. Add to `SHORTCUTS` array:
   ```typescript
   { key: "b", description: "Confirmar/desconfirmar imagen vacía", category: "annotation" },
   ```

2. Add to `AnnotationShortcutOptions` interface:
   ```typescript
   onToggleConfirmedBlank?: () => void;
   isDialogOpen?: boolean;
   ```

3. Add case in the switch statement (after `case "d"`):
   ```typescript
   case "b":
     if (!hasModifier && !o.isDialogOpen) {
       e.preventDefault();
       o.onToggleConfirmedBlank?.();
     }
     break;
   ```

The existing `isSearchFocused` check (line 79-91) already prevents `b` from firing when typing in the species search. The `isDrawing` guard at line 47 prevents it during bbox drawing (though `isDrawing` needs to be wired up — see Step 4).

#### Step 4: Annotation Page — Wire up shortcut + UI

**`src/app/camera-trap/results/[id]/images/[imageId]/page.tsx`**:
- Pass `confirmedBlank: image.confirmedBlank` as a new prop to `ImageAnnotationClient`

**`src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx`**:

1. Add `confirmedBlank: boolean` to props interface
2. Add local state: `const [isConfirmedBlank, setIsConfirmedBlank] = useState(confirmedBlank)`
3. Add handler:
   ```typescript
   const handleToggleConfirmedBlank = useCallback(async () => {
     if (isPending) return;
     startTransition(async () => {
       const result = await toggleConfirmedBlank(imageId);
       if (result.success) {
         setIsConfirmedBlank(result.data.confirmedBlank);
       }
     });
   }, [imageId, isPending, startTransition]);
   ```
4. Wire up in `useAnnotationShortcuts`:
   ```typescript
   onToggleConfirmedBlank: handleToggleConfirmedBlank,
   isDialogOpen: deleteDialogDetectionId !== null || addSpeciesOpen,
   ```
5. Pass `isConfirmedBlank` to `DetectionCardStrip`

#### Step 5: Detection Card Strip — Show confirmed blank indicator

**`src/components/detection-card-strip.tsx`**:

Add `confirmedBlank?: boolean` and `onToggleConfirmedBlank?: () => void` props.

When `confirmedBlank` is true and detections are empty, change the message:

```tsx
if (detections.length === 0) {
  return (
    <div className={cn(
      "flex items-center justify-center gap-2 px-3 py-2 border rounded-lg text-sm",
      confirmedBlank
        ? "bg-green-50 border-green-200 text-green-700"
        : "bg-muted/50 text-muted-foreground"
    )}>
      {confirmedBlank ? (
        <>
          <CheckCircle2 className="h-4 w-4" />
          Imagen confirmada como vacía
        </>
      ) : (
        "No hay detecciones — clic y arrastrar en la imagen para dibujar un cuadro"
      )}
    </div>
  );
}
```

When `confirmedBlank` is true and detections exist (all rejected as false positives), show a banner above the detection cards:

```tsx
{confirmedBlank && detections.length > 0 && (
  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-50 border border-green-200 text-green-700 text-xs">
    <CheckCircle2 className="h-3.5 w-3.5" />
    Imagen confirmada como vacía — detecciones rechazadas como falsos positivos
  </div>
)}
```

#### Step 6: Image Grid — Badge upgrade

**`src/components/image-grid.tsx`**:

1. Add `confirmedBlank?: boolean` to `ImageGridItem` interface
2. Update badge logic — when `confirmedBlank` is true, show a confirmed badge:

```tsx
{image.confirmedBlank ? (
  <div className="absolute top-2 right-2">
    <Badge variant="outline" className="bg-green-50 border-green-300 text-green-700 text-xs">
      Vacía ✓
    </Badge>
  </div>
) : image.status === "processed" && image.detections.length === 0 ? (
  <div className="absolute top-2 right-2">
    <Badge variant="outline" className="bg-white/80 text-xs">
      Vacía
    </Badge>
  </div>
) : null}
```

This overrides the species/detection badges when `confirmedBlank` is true, regardless of whether the image has detections (all rejected as false positives).

**`src/app/camera-trap/results/[id]/page.tsx`** (~line 112-135):
- Include `confirmedBlank: img.confirmedBlank ?? false` in the `gridImages` mapping

#### Step 7: Help Panel — Document shortcut

**`src/components/annotation-help-panel.tsx`** (~line 71):

```tsx
<ShortcutRow keys="b" desc="Confirmar/desconfirmar vacía" />
```

## Edge Cases Handled

| Scenario | Behavior |
|----------|----------|
| `b` on empty image (0 detections) | Toggle `confirmed_blank`, no rejections needed |
| `b` on image with unverified detections | Toggle ON: reject all identifications |
| `b` on image with verified/corrected detections | Toggle ON: force-reject all (destructive, no confirmation dialog) |
| `b` on image already confirmed blank | Toggle OFF, rejections stay |
| Draw manual detection on confirmed-blank image | Auto-clear `confirmed_blank` |
| `b` while search input focused | Types "b" into search (existing behavior) |
| `b` while dialog open | Suppressed via `isDialogOpen` guard |
| `b` on pending image | Rejected by server action (image not viewable) |
| `b` on failed image | Allowed (researcher can see the image) |
| Rapid double-press of `b` | Handled by `isPending` guard (useTransition) |

## Out of Scope

- Audit trail (who/when confirmed blank)
- Auto-rollup to deployment `verified_empty`
- Batch blank confirmation from grid view
- "Advance to next blank" navigation
- Separate "confirmed blank" filter on results page
- Blank confirmation stats in job summary

## References

- Brainstorm: `docs/brainstorms/2026-02-17-blank-image-confirmation-brainstorm.md`
- Existing `markVerifiedEmpty` pattern: `src/app/camera-trap/actions.ts:1297-1358`
- Keyboard shortcuts hook: `src/hooks/use-annotation-shortcuts.ts`
- Learning: Always pair schema.ts changes with ALTER TABLE in push-schema.mjs ([docs/solutions/database-issues/missing-alter-table-migrations-push-schema.md])
