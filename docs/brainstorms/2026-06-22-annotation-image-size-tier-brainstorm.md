---
date: 2026-06-22
topic: annotation-image-size-tier
---

# Faster Image Serving for Camera-Trap Annotation

## What We're Building

A new mid-resolution image tier (`?size=annotate`, **1920px long edge, JPEG q80**)
served by the existing image proxy, so the annotation viewer loads small
(~500 KB) images instead of the full-res originals (~19 MB). Full-res
(`?size=full`) is **unchanged** and remains the source for Camtrap DP export and
classifier training. This is independent of (and complementary to) JPEG
compression — it helps even on uncompressed originals.

## Why This Approach

The system already does on-the-fly resize-and-cache for 400px thumbnails
(`getOrGenerateThumbnail` in `src/lib/thumbnail.ts`): cache hit → local full-res
file → Drive download → `sharp` resize → write → serve. We add one more size
tier using the same machinery. Bounding boxes are stored **normalized (0–1)**
and rendered as `box.x * displayedWidth` (`image-annotation-client.tsx:625`), so
they scale to any served image size — no coordinate changes needed.

Chosen **Approach A** (serve medium everywhere, drop full-res from the viewer)
over Approach B (medium + on-demand full-res button): annotators ID from the
fit-to-screen view, where a 1920px image is visually identical to the original
on any monitor. Simpler, less UI, and the escape hatch can be added later if a
need to pixel-peep emerges.

## Key Decisions

- **Tier:** `annotate` = 1920px long edge, JPEG q80, `fit: inside`,
  `withoutEnlargement: true` (never upscale small originals).
- **Generation:** lazy, reusing the thumbnail pipeline; cached on disk like
  thumbnails (small, persistent, LRU-managed). First view pays one resize;
  every flip after is served from the cached file.
- **Viewer swap:** annotation client preload + gallery overlay URL builder use
  `?size=annotate` instead of `?size=full`.
- **Warm on cache:** the "Cachear imágenes" action (and processing download)
  generates the `annotate` tier alongside thumbnails so a pre-cached deployment
  is instantly fast.
- **Untouched:** `?size=full`, export route, classifier inputs.

## Open Questions

- Confirm the export route + classifier read full-res directly (not via the
  viewer's size param) — expected, verify during implementation.
- Eviction policy for the new tier: treat like thumbnails (persistent, small).

## Next Steps

→ Implement directly (well-scoped): generalize `thumbnail.ts` to a size-keyed
  generator, add `annotate` handling to `/api/ct-images/[id]/route.ts`, swap the
  two viewer URLs, warm during cache/download, verify export path untouched.
