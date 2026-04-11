---
title: "Resume verification at last verified image"
type: feat
date: 2026-04-11
---

# Resume verification at last verified image

## Overview

Add a "Continuar donde dejé" (Resume) control to the camera trap deployment detail page. When clicked, it scrolls the image grid to the **last verified image** (by capture time) and briefly highlights it, so a user returning mid-verification can immediately see the boundary between reviewed and unreviewed images and press forward from there.

"Verified image" = either `images.confirmed_blank = true` **or** the image has at least one detection with `identifications.verification_status` ∈ `("verified", "rejected", "corrected")`.

"Last" = the verified image with the greatest `COALESCE(exifTimestamp, fileModified)` — i.e. the furthest point the user has reached along the deployment timeline. This matches the server-side `IMAGE_TIMESTAMP_ORDER` used everywhere else.

## Problem Statement / Motivation

Deployments routinely contain hundreds to thousands of images. A reviewer may verify 300 images one day, close the tab, and return tomorrow. Today there is no "you are here" marker: they must scan the grid visually looking for the last image with a species badge or blank indicator, or open random images until they find unverified ones. This is slow and error-prone — especially when pagination-style mental models break on a single long scrollable grid.

The verification completion plan (`docs/plans/2026-04-04-feat-deployment-verification-completion-plan.md`) already tracks per-deployment verification progress and auto-completes deployments. This feature is the missing navigation primitive that turns that progress data into a usable resume affordance.

## Proposed Solution

A single-click "Continuar donde dejé" button rendered in the deployment gallery header next to the existing filter/clear controls. On click:

1. If any filters are active, silently reset them (so the target is guaranteed to be in the rendered DOM).
2. Compute the last-verified image ID from the already-loaded `images` prop (no DB round-trip needed — every relevant field is already on `ImageGridItem`).
3. `scrollIntoView({ block: "center", behavior: "smooth" })` the matching `<ImageCard>`.
4. Apply a 2-second ring/pulse highlight to draw the eye.

No new server action, no schema change. Pure client enhancement.

### Why scroll-and-highlight (not open the annotation overlay)

- The grid is the user's situational overview — scrolling preserves context (what's around the boundary) in a way an overlay doesn't.
- The user can still one-click into the annotation flow from the highlighted card.
- Avoids the prefetch/cache warm-up cost of a cold overlay open when the user only wants to orient themselves.
- Decision confirmed during planning.

### Why compute client-side (not via a new server action)

`src/components/image-grid.tsx:16-36` — `ImageGridItem` already carries `confirmedBlank` and `detections[].verificationStatus`. The server pre-orders images by timestamp (`src/app/camera-trap/actions.ts:3252` using `IMAGE_TIMESTAMP_ORDER` at `src/db/schema.ts:1021`). Iterating the array from the tail for the first match is O(n) client-side, executes in <1ms for typical deployments, and avoids another query on an already-slow page.

## Technical Considerations

### Where the button lives

`src/app/camera-trap/results/[id]/results-client.tsx` owns filter state (`filteredImages`, `clearFilters` at line 172, and the filter toolbar near line 227). The Resume button belongs in this toolbar so it can call `clearFilters()` directly, and so it sits alongside the existing filter-reset affordance in the same visual cluster.

### Identifying verified images (client-side predicate)

```ts
// src/app/camera-trap/results/[id]/results-client.tsx
function isVerifiedImage(img: ImageGridItem): boolean {
  if (img.confirmedBlank) return true;
  return img.detections.some(
    (d) =>
      d.verificationStatus === "verified" ||
      d.verificationStatus === "corrected" ||
      d.verificationStatus === "rejected",
  );
}

function findLastVerifiedId(images: ImageGridItem[]): number | null {
  // images are pre-ordered by IMAGE_TIMESTAMP_ORDER on the server, so the
  // last verified by array index == last verified by capture time.
  for (let i = images.length - 1; i >= 0; i--) {
    if (isVerifiedImage(images[i])) return images[i].id;
  }
  return null;
}
```

Pass the **unfiltered** `images` prop (not `filteredImages`) so the target doesn't depend on what the user is currently filtering for.

### Scrolling to the target card

Add a `data-image-id={image.id}` attribute to `<ImageCard>` in `src/components/image-grid.tsx` (the grid currently has no stable per-card selector). Then:

```ts
function scrollToImage(id: number) {
  // rAF to ensure the DOM has settled after clearFilters() state update.
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-image-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("ring-4", "ring-primary", "ring-offset-2", "animate-pulse");
    setTimeout(() => {
      el.classList.remove("ring-4", "ring-primary", "ring-offset-2", "animate-pulse");
    }, 2000);
  });
}
```

Video-frame groupings (`src/components/image-grid.tsx:101`) must also carry `data-image-id` on at least the first frame so grouped frames are still reachable by ID.

### Button visibility rules

- **Hidden** when `images.length === 0`.
- **Hidden** when no verified images exist (nothing to resume from — deployment is pristine).
- **Hidden** when **all** images are verified (`verifiedCount === total`) — deployment is done; the existing completion banner already handles that state.
- **Shown** otherwise, with label `Continuar donde dejé` and an icon (`BookmarkCheck` or `ArrowDownToLine` from lucide-react).

### Filter interaction

Filters are reset silently on click. This is the least-surprising behavior: the button promises to take you somewhere, and it always works. Alternative behaviors (respect filters, hide while filtered) were rejected during planning because they either break the promise or add cognitive overhead. A one-line toast (`"Filtros despejados"`) is optional — prefer no toast unless usability testing reveals confusion.

### Keyboard shortcut

Bind `r` (for *reanudar*) to the same action at the document level while no overlay is open. Guard against firing when focus is in an input/textarea (match the guard already used by annotation shortcuts — see `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` for the pattern).

### Accessibility

- Button must have a visible Spanish label plus an `aria-label` matching.
- The pulse highlight must not be the only signal — the smooth scroll itself moves the viewport, and focus should move to the card via `el.focus({ preventScroll: true })` after `scrollIntoView` so screen readers announce the landing.
- Respect `prefers-reduced-motion`: fall back to `behavior: "auto"` and skip `animate-pulse`.

## Acceptance Criteria

- [x] Button labeled **"Continuar donde dejé"** appears in the deployment gallery toolbar when the deployment has ≥1 verified and ≥1 unverified image.
- [x] Button is hidden when there are zero verified images, or when all images are verified.
- [x] Clicking the button clears any active filters, scrolls the grid to center on the last-verified-by-capture-time image, and highlights it for ~2 seconds.
- [x] "Verified" matches the predicate: `confirmedBlank === true` OR any detection with `verificationStatus` ∈ `("verified","rejected","corrected")`.
- [x] The target is computed from the unfiltered `images` list, so filter state cannot change which image is chosen.
- [x] Keyboard shortcut `r` triggers the same behavior when no overlay is open and focus is not in an input.
- [x] `prefers-reduced-motion` users get instant scroll, no pulse animation.
- [x] Works for deployments where the last-verified image is inside a video-frame group.
- [x] Verified tooling: unit test for `findLastVerifiedId()` covering: empty list, all-unverified, all-verified, mixed with verified in middle, verified blank, mixed video frames.
- [ ] Manual QA on a real deployment with ~500+ images; button lands within one viewport of the expected frontier.

## Success Metrics

- Mid-verification returns are measurably faster (subjective; ask the 2-3 staff who currently verify regularly after ship).
- No additional DB load on the deployment page (zero new queries).
- Zero reports of "I lost my place" in internal feedback after two weeks.

## Dependencies & Risks

**Dependencies**
- None. Feature is additive and client-side only. No schema change, no server action, no new dependency.

**Risks**
- **Wrong boundary semantics.** If a user verifies a species in image #450 and then jumps back to verify image #10, "last verified" by timestamp is #450 — they lose image #10 as a progress marker. Mitigation: document that the button finds the *rightmost* frontier. If this turns out to be wrong in practice we can switch to "last verified by `verifiedAt`" in a follow-up (requires the field to be exposed on `ImageGridItem`, which it currently isn't).
- **Grid re-order drift.** If the server-side ordering ever changes to non-timestamp order without updating this code, the tail-scan becomes "last verified in display order" instead of "last by capture time." Mitigation: add a short comment in `findLastVerifiedId` pointing at `IMAGE_TIMESTAMP_ORDER`, so the coupling is discoverable.
- **Video frame groups.** Grid groups video frames under one parent (`src/components/image-grid.tsx:101-106`). If `data-image-id` is only on the first frame but the last verified frame is #7 of a group, the scroll target snaps to the group header — usually acceptable since the user still sees the group, but worth verifying during QA.
- **`animate-pulse` + ring** may look odd in combination. If visually noisy, drop `animate-pulse` and keep the static ring for 2s.

## References & Research

### Internal
- Deployment detail entry: `src/app/camera-trap/[id]/page.tsx:206` — renders `<DeploymentGalleryClient />`.
- Gallery wrapper with filter state: `src/app/camera-trap/results/[id]/results-client.tsx:105` (`filteredImages`), `:172` (`clearFilters`), `:227` (filter toolbar — add button here).
- Grid component: `src/components/image-grid.tsx:16-36` (`ImageGridItem` — already has `confirmedBlank` and `detections[].verificationStatus`), `:101-106` (video grouping).
- Server image fetch + ordering: `src/app/camera-trap/actions.ts:3217` (`getDeploymentResultsData`), `:3252` (order by `IMAGE_TIMESTAMP_ORDER`).
- Ordering expression: `src/db/schema.ts:1021` (`IMAGE_TIMESTAMP_ORDER = COALESCE(exifTimestamp, fileModified)`).
- Verification status enum: `src/db/schema.ts:371-375` (`unverified | verified | rejected | corrected`).
- Filter-aware overlay navigation (prior art for filter/list interaction): `src/app/camera-trap/[id]/deployment-gallery-client.tsx:68-74`.
- Auto-completion stats (source of "total verified vs unverified" knowledge): `docs/plans/2026-04-04-feat-deployment-verification-completion-plan.md`.
- Verification filter bug fix (why we reset filters): `docs/plans/2026-04-06-fix-annotation-respects-filtered-images-plan.md`.

### CLAUDE.md conventions applied
- Spanish UI strings (hardcoded) — `"Continuar donde dejé"`, `"Filtros despejados"` (if toast used).
- No new server actions means no `requirePermission` wiring; read-only DOM work on already-authorized data.
- No schema change, no DB query, no migration.

## Files to Touch

- `src/components/image-grid.tsx` — add `data-image-id` attribute on standalone and video-frame cards.
- `src/app/camera-trap/results/[id]/results-client.tsx` — add `findLastVerifiedId`, Resume button in toolbar, `r` keyboard shortcut, `scrollToImage` helper.
- `src/app/camera-trap/results/[id]/results-client.test.ts` (new, or nearest existing test file) — unit tests for `findLastVerifiedId`.

## Out of Scope

- Per-user "last visited" bookmarks persisted server-side (would require schema change and a new action; the timestamp-based heuristic is good enough).
- "Next unverified after boundary" jump — easy follow-up if staff prefer it.
- Resume applied to the job results page (`src/app/camera-trap/results/[id]/page.tsx`) — deployment view is the primary entry point; add later if requested.
- Opening the annotation overlay directly (scroll-and-highlight chosen during planning).
