---
title: "feat: Annotation image size tier (1920px) for fast camera-trap serving"
type: feat
date: 2026-06-22
brainstorm: docs/brainstorms/2026-06-22-annotation-image-size-tier-brainstorm.md
---

# ✨ Annotation Image Size Tier (1920px) for Fast Camera-Trap Serving

## Overview

Add a mid-resolution image tier — `?size=annotate` at **1920px long edge, JPEG
q80** — to the camera-trap image proxy, so the annotation viewer loads ~500 KB
images instead of the ~19 MB full-res originals. Full-res (`?size=full`) is
**unchanged** and remains the source for Camtrap DP export and classifier
training. Reuses the existing thumbnail lazy-generate-and-cache machinery; no
schema changes, no new job types.

This is **Approach A** from the brainstorm (serve medium everywhere, drop
full-res from the viewer), chosen because bounding boxes are normalized and a
1920px image is visually identical to the original at fit-to-screen.

## Problem Statement / Motivation

The annotation viewer requests `?size=full` for every photo. Even when images
are cached on the server's disk (so there's no Drive round-trip), each one is
the full ~19 MB original — confirmed in production: GIZ-004_V1's uncompressed
images average 19.2 MB. The bottleneck is the **server → browser transfer**,
which disk caching cannot fix. A 1920px/q80 re-encode is ~500 KB — roughly
**35–40× less data** — and looks identical at fit-to-screen.

This is independent of (and stacks with) JPEG compression: it helps even on
uncompressed originals, and even more once a deployment is compressed.

## Proposed Solution

One new size tier, generated lazily and cached on disk exactly like thumbnails:

```
GET /api/ct-images/123?size=annotate
  → cache hit (data/annotate/{depId}/123.jpg)?           serve
  → else local full-res file (images.path)?              resize → cache → serve
  → else download from Drive (driveFileId)               resize → cache → serve
```

The annotation viewer + gallery overlay switch their image/preload URLs from
`?size=full` to `?size=annotate`. The existing "Cachear imágenes" action and the
processing download warm the new tier alongside thumbnails so a pre-cached
deployment is instantly fast.

Bounding boxes need no changes: they're stored normalized (`bbox_x` … as `real`)
and rendered as `box.x * displayedWidth`
(`image-annotation-client.tsx:625`), so they scale to any served resolution.

## How Caching & Eviction Works (answers "will annotation versions be deleted when the cache is full?")

**Short answer: yes, they can be evicted — but it's cheap, self-healing, and
managed by a single derivative cache.**

**Unify the thumbnail and annotate caches into one.** Both are disposable,
regenerable derivatives of the original; there's no reason to manage two
budgets and two eviction routines. The 400px thumb and the 1920px annotate live
**side-by-side in the same per-deployment directory** under one budget and one
LRU. This works cleanly because the existing eviction already sums *all files in
each deployment dir* (`thumbnail.ts:62–70`), so it governs both tiers for free.
Net result: **two caches total, not three.**

| Cache | Directory | Budget (env) | Recovery cost on eviction |
|-------|-----------|--------------|---------------------------|
| Full-res | `data/cache/ct-images/{depId}/` | `CT_IMAGE_CACHE_MAX_GB` = 30 | Expensive — re-download ~19 MB/image |
| **Derivatives** (400px thumb **+** 1920px annotate) | `data/thumbnails/{depId}/` | `CT_DERIVATIVE_CACHE_MAX_GB` = **15** | Cheap — regenerate one image |

File naming inside the shared dir (no migration of existing thumbs):
- thumb → `{imageId}.jpg` (unchanged — existing thumbnails keep working)
- annotate → `{imageId}@1920.jpg`

Mechanics (the generalized `evictDerivativesIfOverLimit`, was
`evictThumbnailsIfOverLimit`, `thumbnail.ts:40`):

- **Deployment-level LRU by mtime.** When the derivative cache exceeds its
  budget, the oldest *deployment directories* are deleted whole (dropping both
  that deployment's thumbs and annotate variants), oldest first, until back
  under budget. Skips the deployment currently being warmed.
- **Self-healing.** An evicted variant regenerates on its next view via the
  fall-through above (cache → local full-res resize → Drive download + resize).
  Worst case after eviction = the *first* view of that image is slow again
  (~1 Drive fetch), then fast.
- **Isolated from full-res.** Separate directory + budget; never competes with
  the full-res cache. Disk-budget math: 30 + 15 = 45 GB of caches, comfortably
  under the ~193 GB disk and clear of the 20 GB `CT_PROCESS_DISK_MARGIN_GB`
  headroom that protects ML downloads.
- **Browser cache covers repeat views regardless of server eviction.** Responses
  keep `Cache-Control: public, max-age=31536000, immutable` (route.ts:102), so a
  user re-viewing an image in the same session never re-hits the server. (Note:
  the DevTools "Disable cache" checkbox in the original report defeats this —
  real annotators benefit from it.)

**Eviction trigger points:**
1. **Batch (authoritative):** after warming during the cache/download job, call
   `evictDerivativesIfOverLimit(deploymentId)` — replaces the thumbnail-only
   call at `drive-downloader.ts:375`.
2. **Lazy (throttled):** the proxy's on-demand path is the common case for
   deployments that weren't pre-cached, and annotate files are ~20× bigger than
   thumbnails, so unbounded lazy growth matters more now. Add a lightweight
   **module-level time gate** (run `evictDerivativesIfOverLimit` at most once per
   ~5 min, fire-and-forget, never blocking the response).

**Sizing rationale for the 15 GB default (up from the old 5 GB thumb-only cap):**
1920px/q80 ≈ 500 KB and now dominates the budget (thumbs are ~22 KB, negligible).
15 GB holds ~30K annotate images — several large deployments warm at once. A
644-image deployment ≈ 320 MB; an 8,000-image deployment ≈ 4 GB. Too small a
budget would thrash and trigger repeated 19 MB Drive re-downloads. Tunable via
`CT_DERIVATIVE_CACHE_MAX_GB` (falls back to the old `CT_THUMBNAIL_CACHE_MAX_GB`
if set, for back-compat).

## Technical Approach

### 1. One unified derivative cache with per-tier configs — `src/lib/thumbnail.ts`

Introduce a tier config. Both tiers share ONE directory (`THUMBNAIL_DIR =
data/thumbnails`) and ONE budget/eviction; only the filename suffix, long edge,
and quality differ. Keep `getOrGenerateThumbnail` as a thin wrapper so existing
callers don't change (`image-grid.tsx`, `species/actions.ts`,
`[id]/preview/page.tsx`, public routes).

```ts
// src/lib/thumbnail.ts (pseudo)
export interface ImageSizeTier {
  suffix: string;       // "" (thumb → {id}.jpg)  |  "@1920" (annotate → {id}@1920.jpg)
  longEdge: number;     // 400 | 1920
  quality: number;      // 80
}
export const THUMB_TIER:    ImageSizeTier = { suffix: "",      longEdge: 400,  quality: 80 };
export const ANNOTATE_TIER: ImageSizeTier = { suffix: "@1920", longEdge: 1920, quality: 80 };

// ONE shared dir + ONE budget (back-compat fallback to the old thumb knob)
const DERIVATIVE_DIR = THUMBNAIL_DIR; // data/thumbnails — no migration
const DERIVATIVE_CACHE_MAX_BYTES =
  parseFloat(process.env.CT_DERIVATIVE_CACHE_MAX_GB
             || process.env.CT_THUMBNAIL_CACHE_MAX_GB || "15") * 2**30;

export function sizedPath(tier, depId, imageId) {
  return path.join(DERIVATIVE_DIR, String(depId), `${imageId}${tier.suffix}.jpg`);
}

// resize: thumb keeps width-only (.resize(longEdge)); annotate bounds the LONG
// edge and never upscales. Parameterize per tier:
//   tier === ANNOTATE_TIER
//     ? .resize(longEdge, longEdge, { fit: "inside", withoutEnlargement: true })
//     : .resize(longEdge)
sharp(source)./* per-tier resize */.jpeg({ quality: tier.quality }).toBuffer();

export function getOrGenerateSized(tier, imageId, depId, localPath, driveFileId, downloadFn): Promise<Buffer|null>
export function evictDerivativesIfOverLimit(skipDeploymentId?): Promise<void> // sums whole dep dirs → both tiers

// back-compat wrappers (zero churn at call sites)
export const getOrGenerateThumbnail   = (...a) => getOrGenerateSized(THUMB_TIER, ...a);
export const evictThumbnailsIfOverLimit = (skip?) => evictDerivativesIfOverLimit(skip);
```

> Eviction stays deployment-dir LRU and already sums every file in the dir, so
> no eviction logic changes are needed beyond the rename + budget bump — it now
> naturally accounts for the `@1920` files sitting next to the thumbs.
> Keep thumbnail resize/filename byte-identical to avoid regenerating existing
> 400px thumbs.

### 2. Proxy route — `src/app/api/ct-images/[id]/route.ts`

Add a branch mirroring the `size === "thumb"` block (route.ts:110–133):

```ts
if (size === "annotate") {
  const buf = await getOrGenerateSized(ANNOTATE_TIER, image.id, image.deploymentId,
                                       image.path, image.driveFileId, downloadFileToBuffer);
  if (!buf) return 404;
  maybeEvictDerivatives();         // throttled, fire-and-forget (module time gate)
  return new NextResponse(buf, { headers: { ...headers, "Content-Type": "image/jpeg" } });
}
```

### 3. Viewer URLs (the Approach-A swap)

- `image-annotation-client.tsx` — preload calls (lines ~261, 265): `?size=full` → `?size=annotate`.
- `deployment-gallery-client.tsx` — overlay URL builder (line ~201): `?size=full` → `?size=annotate`.

Leave the thumbnail-grid (`?size=thumb`) and any download/full-res buttons as-is.

### 4. Warm during cache/download — `src/lib/drive-downloader.ts`

Generalize `generateThumbnails` (lines 107–148) to produce BOTH tiers in the
same pass (thumb + annotate from the same in-memory full-res buffer it already
reads). It MUST run in the same pre-release window (before `releaseChunkFiles`),
so it resizes from the local full-res file with no Drive cost. The existing
`evictThumbnailsIfOverLimit(deploymentId)` call at line 375 becomes
`evictDerivativesIfOverLimit(deploymentId)` (same call via the back-compat
wrapper) — now governing both tiers.

### 5. Cleanup parity (free with unification)

Because both tiers share `data/thumbnails/{depId}/`, the existing
`deleteDeploymentThumbnails` (which `rm -rf`s the whole deployment dir) already
removes the `@1920` variants too. **No new cleanup path needed** — just confirm
all current callers (deployment delete, cache clear) still go through it.

### 6. Verify full-res paths untouched (no code, just confirm)

- `src/app/api/camera-trap/export/route.ts` (Camtrap DP export) reads full-res /
  `?size=full`, not the viewer size param.
- Classifier / training-export inputs read full-res from disk or Drive.

## Edge Cases

- [ ] **Full-res already released** (chunked ML NULLed `images.path`): annotate
      regenerates via Drive download — handled by the fall-through.
- [ ] **Non-JPEG / video frames:** resize via `sharp` works for png/webp; output
      is always JPEG. Frames have no `driveFileId` but do have `images.path`
      while cached — resize from disk. If neither, return 404 (same as full).
- [ ] **Tiny originals (< 1920px):** `withoutEnlargement` prevents upscaling;
      served at native size (still re-encoded at q80).
- [ ] **Corrupt original:** `sharp` throws → 502 (mirror thumbnail error
      handling, route.ts:125–132); viewer shows its existing error state.
- [ ] **Concurrent first-view of same image:** two requests may both generate;
      last write wins, harmless (same as thumbnails today).
- [ ] **Eviction mid-view:** browser `immutable` cache covers it; otherwise the
      next request regenerates.

## Acceptance Criteria

- [ ] `GET /api/ct-images/{id}?size=annotate` returns a ~1920px-long-edge JPEG.
- [ ] Annotation viewer + gallery overlay request `?size=annotate`; Network tab
      shows ~hundreds of KB per image, not ~19 MB.
- [ ] Bounding boxes render correctly aligned at the new resolution.
- [ ] `?size=full`, export, and classifier inputs are byte-for-byte unchanged.
- [ ] Both tiers share `data/thumbnails/{depId}/` (thumb `{id}.jpg`, annotate
      `{id}@1920.jpg`), capped by one `CT_DERIVATIVE_CACHE_MAX_GB` (default 15),
      LRU-evicted together. No third cache directory is introduced.
- [ ] Existing 400px thumbnails are NOT regenerated (byte-identical behavior).
- [ ] "Cachear imágenes" / processing download warms both tiers before full-res
      release.
- [ ] Evicting the derivative cache does not touch the full-res cache; next view
      regenerates the evicted variant.
- [ ] `npm run test:run` + `npm run lint` pass; `docker compose build` succeeds.

## Config Knobs

- `CT_DERIVATIVE_CACHE_MAX_GB` (default `15`) — unified derivative-cache disk
  budget (thumbs + annotate). Falls back to the old `CT_THUMBNAIL_CACHE_MAX_GB`
  if that's set, for back-compat. **Net change: one knob, not two.**
- Long edge / quality hardcoded at 1920 / 80 (YAGNI — add env knobs only if
  needed).

## Testing

- **Unit** (`thumbnail.ts`): tier resize bounds the long edge and never
  upscales; `evictDerivativesIfOverLimit` deletes oldest dirs until under budget
  and skips the active deployment, accounting for both `{id}.jpg` and
  `{id}@1920.jpg` in each dir.
- **Integration** (proxy): `size=annotate` serves from cache when present;
  regenerates from local full-res when cache-missed; falls back to Drive when
  `images.path` is null; 404 when no source.
- **Manual:** open the annotation viewer on an uncompressed deployment
  (GIZ-004_V1), confirm per-image payload drops to ~hundreds of KB and boxes
  align; flip rapidly and confirm prefetch keeps up.

## Risks & Mitigations

- **Lazy-path cache growth between batch evictions.** Annotate files are ~20×
  thumbnails, so a deployment viewed but never pre-cached could grow the dir.
  *Mitigation:* throttled lazy `evictDerivativesIfOverLimit` (module time gate,
  fire-and-forget). Best-effort across multiple Next workers; acceptable.
- **First-view latency on cache-miss** when full-res is gone (one 19 MB Drive
  fetch + resize). *Mitigation:* warm during "Cachear imágenes"; encourage
  pre-caching deployments before annotation sessions.
- **Disk pressure interacting with the ML download guard.** *Mitigation:* 45 GB
  total cache cap << 193 GB disk and clear of the 20 GB process margin; keep the
  derivative default modest.
- **Generalizing `thumbnail.ts` touches shared code** used by public routes /
  grids. *Mitigation:* keep `getOrGenerateThumbnail` / `evictThumbnailsIfOverLimit`
  as unchanged wrappers and the thumb resize/filename byte-identical; only a
  budget bump + a new sibling variant are added.

## Out of Scope

- Compression-status column (separate, already implemented).
- On-demand full-res zoom in the viewer (Approach B) — defer; can layer on later.
- Extending `?size=annotate` to public ct-image routes — trivial once the tier
  exists, but not needed now.
- Backfilling annotate for all deployments — generated lazily / on cache.

## References

- Brainstorm: `docs/brainstorms/2026-06-22-annotation-image-size-tier-brainstorm.md`
- Thumbnail tier + eviction: `src/lib/thumbnail.ts:5,16,40,100,129`
- Proxy route (thumb/full branches, cache headers): `src/app/api/ct-images/[id]/route.ts:95,102,110,137`
- Full-res cache + eviction knob: `src/lib/drive-downloader.ts:32,35,375,785`
- Thumbnail warming in download/chunked: `src/lib/drive-downloader.ts:107,358,538`
- Normalized bbox rendering: `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx:625`
- Gallery overlay URL: `src/app/camera-trap/[id]/deployment-gallery-client.tsx:201`
- Cache action / warm point: `src/app/camera-trap/drive-actions.ts` (`cacheImagesJobInternal`, `downloadDeploymentForProcessing`)
