---
title: BirdNET Confidence Threshold Filter
type: feat
date: 2026-05-13
brainstorm: docs/brainstorms/2026-05-13-birdnet-confidence-threshold-filtering-brainstorm.md
---

# BirdNET Confidence Threshold Filter

## Overview

Add a user-configurable global confidence threshold (default **0.7**, range 0.1–1.0) that filters BirdNET detections at **read time** across every audio-module surface where users see species counts, detection lists, charts, or exports. Storage is unchanged — BirdNET continues to write everything ≥ 0.1 — so users can retune freely without re-ingesting. Threshold state lives in the URL (`?conf=0.70`), falling back to `localStorage`, falling back to the hard-coded default.

Why this matters: the Tebbutt et al. (2026) study shows BirdNET's raw confidence score is not a probability, and the right cutoff varies 10× across species. Today the portal presents 0.1+ noise as if it were signal. A single global knob is a first-class, defensible improvement; species-specific thresholds remain an explicit follow-up (see brainstorm F1).

## Problem Statement / Motivation

- Today `audio_identifications.confidence` is stored but never used to filter anything in the UI. Every count, chart, and table mixes high-confidence detections with model noise.
- Field ecologists currently have no way to compare a "permissive" view (0.3) with a "publication" view (0.8). They take whatever the portal shows.
- The recently-reviewed Tebbutt paper provides a citable, defensible default (~0.7) and a story we can put in the UI.
- Annotators on the validation page need to see the *full* candidate set including low-confidence borderline cases; everyone else needs the filtered view by default.

## Proposed Solution

Three new pieces, plus surgical edits to every existing aggregation site:

1. **Query-layer helper** — a single `applyConfidenceFilter(threshold)` function that emits the same WHERE clause everywhere it's used. Source of truth for filter semantics.
2. **Client state hook** — `useConfidenceThreshold()` reads URL → localStorage → default, with validation, debounced URL writes, and 2-decimal precision.
3. **UI control** — `<ConfidenceThresholdSlider>` shadcn/Radix component placed in the filter bar of every affected view, with citation tooltip and current-value label.

Server actions and RSC pages read `conf` from `searchParams` directly (so RSC cache invalidates naturally when the URL changes). Client components use the hook.

## Filter Semantics (the locked rule)

For every read of `audio_identifications`:

```
INCLUDE the row IF any of the following are true:
  • verification_status IN ('verified', 'corrected')      -- human-curated truth, always shown
  • confidence IS NULL AND verification_status != 'rejected'  -- manual annotation, no model score
  • verification_status = 'unverified' AND confidence >= :threshold
EXCLUDE always when:
  • verification_status = 'rejected'
```

This single rule must be used at every aggregation site. The helper makes it impossible to drift.

## Technical Considerations

### Architecture impacts
- New `src/lib/audio-confidence.ts` module: `DEFAULT_CONFIDENCE_THRESHOLD`, `CONFIDENCE_MIN`, `CONFIDENCE_MAX`, `CONFIDENCE_STEP`, `parseThresholdParam()`, `applyConfidenceFilter()`.
- Server actions (`src/app/audio/actions.ts`) gain an optional `threshold: number` argument on each detection-reading function; RSC pages thread `searchParams.conf` through.
- No new tables, no schema migrations.

### Performance implications
- Compound WHERE on `audio_identifications` adds two predicates. Both columns already exist; no scans worse than today.
- Slider debounce (300ms, `router.replace`) avoids URL/RSC thrash during drag.
- No N+1 risk — the helper produces a single composable Drizzle `sql` fragment.

### Security
- `parseThresholdParam()` validates and clamps the URL value: NaN, negative, > 1, or non-numeric → fall back to default (0.7). No SQL injection surface (Drizzle-parameterised), but defensive parsing means we never trust the URL.
- Server actions still call `requirePermission(projectId, 'viewer')` for the "grabaciones" project (per learnings — audio routes use `grabaciones`, not `camera-trap`).

### Accessibility
- Slider: `aria-valuemin/max/now`, arrow-key step 0.05, touch target ≥ 44px, paired numeric input next to slider so keyboard / screen-reader users can type a value.
- Visible current-value label (e.g., `0.70`), always.

## Acceptance Criteria

### Functional

- [ ] On every audio analytics view, default landing state shows only detections matching the filter rule above, with threshold = 0.7.
- [ ] `?conf=0.50` in the URL overrides the default; the slider reflects 0.50; `localStorage` is **not** written from URL params (avoid silent mutation of other users' defaults).
- [ ] Adjusting the slider updates the URL (`router.replace`, debounced 300ms), writes to `localStorage`, and re-renders all affected charts/counts.
- [ ] On a fresh visit with no URL param and no `localStorage`, the user lands on 0.7.
- [ ] Invalid `?conf` values (`abc`, `-1`, `2`, `NaN`) silently fall back to default; no crash, no error toast.
- [ ] The slider is keyboard-operable: tab to focus, ←/→ step 0.05, Home/End jump to bounds.
- [ ] On the annotation page, a **"Mostrar todas las detecciones"** toggle is visible above the detection list. When ON, the page renders all rows ≥ 0.1 (verified, rejected, corrected, unverified — everything). The spectrogram overlay reflects the same set.
- [ ] When the toggle is OFF (default), the filter rule applies — including hiding rejected rows.
- [ ] Manually rejected detections never appear in any user-facing view, regardless of threshold or "show all" toggle.
- [ ] Manually verified or corrected detections always appear, regardless of threshold.
- [ ] Detections with NULL confidence (manual annotations) always appear unless explicitly rejected.
- [ ] Threshold persists in the URL when navigating from `/audio/[id]` to `/audio/[id]/annotate/[fileId]` and back (via `<Link>` props).

### Counts / charts

- [ ] `fetchAudioDeployments()` per-deployment counts (`totalDetections`, `totalSpecies`, `unverifiedCount`) all respect the threshold passed in.
- [ ] `verifiedCount` is unaffected by threshold (verified rows always pass).
- [ ] Deployment detail page (`/audio/[id]`) `birdnetStats` panel respects threshold from `searchParams`.
- [ ] Threshold = 1.0 produces an empty-state message in charts, not a broken render.

### Export

- [ ] New endpoint `GET /api/audio/export?deployment=<id>&conf=<value>` returns CSV of detections matching the rule.
- [ ] CSV filename is `birdnet_dep<id>_conf<NNN>_<YYYY-MM-DD>.csv` (e.g., `birdnet_dep42_conf070_2026-05-13.csv`).
- [ ] CSV's first line is a `# confidence_threshold=0.70` comment; second line is the header row.
- [ ] Export respects the URL threshold (independent of any UI "show all" toggle).

### Job-completion toast (resolved blocker)

- [ ] BirdNET job-completion toast/status reports **raw** detection and species counts (i.e., threshold = 0.1) so users see what the model actually produced. Toast copy explicitly notes "antes de filtrar por confianza".
- [ ] The deployment dashboard behind the toast respects the user's current threshold, so the two numbers can disagree by design.

### Quality / non-functional

- [ ] All current audio tests still pass.
- [ ] New unit tests cover `parseThresholdParam()` (valid, edge, malicious inputs) and `applyConfidenceFilter()` (all four verification states × above/below threshold × NULL confidence).
- [ ] At least one integration test exercises `fetchAudioDeployments({ threshold: 0.9 })` with seeded data and asserts the count contract.
- [ ] A11y: slider passes `axe` on storybook or a smoke test.

## Implementation Phases

### Phase 1 — Foundation (data layer + state) ✅

**Files (new):**
- `src/lib/audio-confidence.ts`
  - `export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7`
  - `export const CONFIDENCE_MIN = 0.1`
  - `export const CONFIDENCE_MAX = 1.0`
  - `export const CONFIDENCE_STEP = 0.05`
  - `export const CONFIDENCE_STORAGE_KEY = "audio.confidenceThreshold.v1"`
  - `export function parseThresholdParam(raw: string | string[] | undefined): number` — validate, clamp, fall back to default.
  - `export function applyConfidenceFilter(threshold: number)` — returns a Drizzle `sql` fragment matching the filter rule above. Synchronous. Reused everywhere.
  - `export function formatThreshold(value: number): string` — `"0.70"` 2-decimal canonical form.
- `src/hooks/use-confidence-threshold.ts`
  - Returns `[threshold: number, setThreshold: (v: number) => void]`.
  - Read order: URL `?conf` → `localStorage` → default.
  - `setThreshold` debounces (300ms) → `router.replace` with new `?conf` → write to localStorage (only when set via slider, not from URL hydration).
  - 2-decimal canonicalisation on both read and write.

**Tests:**
- `tests/unit/audio-confidence.test.ts` — parseThresholdParam matrix.
- `tests/integration/apply-confidence-filter.test.ts` — seeded fixtures cover all four verification states × confidence above/below × NULL.

### Phase 2 — Wire through queries ✅

**Files (edit):**
- `src/app/audio/actions.ts`
  - `fetchAudioDeployments(opts: { threshold?: number })` — accept optional threshold (defaults to constant). Update queries at lines 154–164 (totals), 159–164 (species), 172–178 (unverifiedCount) to AND with `applyConfidenceFilter(threshold)`. Leave `verifiedCount` (lines 165–171) unchanged.
  - `fetchAudioFiles({ threshold })` — line 292 detection count.
- `src/app/audio/[id]/page.tsx`
  - Read `searchParams.conf` via `parseThresholdParam`, pass to actions. Update `birdnetStats` panel queries (lines 182–192).
- `src/app/audio/[id]/annotate/[fileId]/page.tsx`
  - Read `searchParams.conf` and `searchParams.showAll` ("1" or absent). When `showAll` is set, bypass filter (i.e., effective threshold = 0.1, include all statuses except `rejected`); otherwise apply the rule.

**Tests:**
- Update `tests/integration/fetch-audio-files.test.ts` to cover threshold parameter.
- New `tests/integration/fetch-audio-deployments-threshold.test.ts`.

### Phase 3 — UI control ✅

**Files (new):**
- `src/components/ui/slider.tsx` — shadcn wrapper over `@radix-ui/react-slider` (one-time setup; package already in deps).
- `src/components/audio/confidence-threshold-slider.tsx`
  - `<ConfidenceThresholdSlider />` — reads `useConfidenceThreshold`, renders slider + numeric input + value label + info popover.
  - Info popover cites Wood & Kahl (2024) and Tebbutt et al. (2026), explains in 2 sentences (Spanish) what the threshold does.

**Files (edit):**
- `src/app/audio/[id]/page.tsx` — drop slider into the deployment header / filter bar (Client Component island).
- `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx`
  - Slider in toolbar.
  - "Mostrar todas las detecciones" toggle next to slider; when active, sets `?showAll=1`.
  - Spectrogram overlay (`fft-spectrogram.tsx`) accepts a `visibleDetectionIds: Set<string>` prop so it draws only currently-visible boxes; client filters using the same rule.
- `src/app/audio/page.tsx` / audio index — slider in header for cross-deployment view (if such a view aggregates detections; otherwise skip).

**Tests:**
- Component smoke test for slider with keyboard nav.

### Phase 4 — CSV Export ✅

**Files (new):**
- `src/app/api/audio/export/route.ts` — `GET` handler. Auth: `requirePermission(grabacionesProjectId, 'viewer')`. Query params: `deployment`, `conf` (optional, defaults to 0.7). Returns `Content-Type: text/csv` with the filename pattern above.

CSV columns (initial cut):
```
detection_id, file_path, start_time_s, end_time_s, species_scientific, species_common, confidence, verification_status, recorded_at
```
First line: `# confidence_threshold=0.70`
Second line: header

**Files (edit):**
- `src/app/audio/[id]/page.tsx` — add "Exportar CSV" button that links to the export route with the current `conf`.

**Tests:**
- `tests/integration/audio-export.test.ts` — fixture-based check of row count vs threshold.

### Phase 5 — Polish ✅

- [x] Audit every place that says "X detecciones" or "Y especies" — confirm the number was produced through the helper or is explicitly tagged "raw/sin filtrar". (Post-job message now says "antes de filtrar por confianza".)
- [x] Add empty-state copy for `threshold = 1.0` (slider shows amber hint when at maximum).
- [x] Confirm `<Link>` from deployment to annotation page preserves `?conf=…` (router.push in recordings-shell + buildSiblingUrl in annotation-client cover all five nav sites).
- [x] Confirm post-job toast text says raw counts with disclaimer.
- [x] Add a "Restablecer al predeterminado (0.70)" link next to the slider (added in Phase 3 slider component).
- [x] Slider placed on audio index page in addition to deployment detail + annotation page (per plan instruction "if such a view aggregates detections, otherwise skip").

## Success Metrics

- **Correctness:** Threshold 0.7 default reduces the "noisy" species set visible on the dashboard by ≥ 30% relative to threshold 0.1, *without* dropping any verified detections.
- **Adoption:** Users actually move the slider — measured by non-default `?conf` values in shared URLs (anecdotal at first; we don't track analytics).
- **Reproducibility:** A PI can email their colleague a URL + CSV, and the colleague sees byte-identical detection rows in the table and the CSV.
- **No regressions:** All current tests pass; no DB writes change; no BirdNET ingestion changes.

## Dependencies & Risks

| Risk | Impact | Mitigation |
|---|---|---|
| One aggregation site missed — UI inconsistency | Med | Search-and-replace approach: grep for `audio_identifications` / `audio_detections` after Phase 2; require every match to either use the helper or be annotated `// raw-counts:explanation`. |
| Slider re-renders thrash RSC and feel laggy | Med | Debounce slider 300ms; `router.replace` not `push`; profile during implementation. |
| Existing tests assume current count behaviour | Low | Update fixtures; failures will be loud and easy to fix. |
| `corrected` verification state behaves differently than expected in production | Low | Filter rule treats `corrected` same as `verified` (always shown). Validate against a real production row in QA. |
| User on a phone can't drag a slider precisely | Low | Pair slider with a numeric input; arrow-key step 0.05 on desktop. |
| User sets URL `?conf=0.05` (below BirdNET floor) | Low | Clamp to 0.1 (BirdNET's floor); the value is honoured but cannot show anything BirdNET didn't write. |

## Alternative Approaches Considered (and rejected)

| Alternative | Why rejected |
|---|---|
| Raise BirdNET's `--min_conf` at ingestion (destructive filter) | Loses ability to retune later; brainstorm rules it out explicitly. |
| Single admin-managed app-wide setting | No per-user exploration; ecologists need to compare 0.5 vs 0.8 on the same data. |
| Per-deployment DB-stored threshold | Adds schema state and admin UX for negligible value over URL+localStorage. |
| Species-specific thresholds from paper now | Real value but requires recorder-type tracking (paper has separate values per recorder) and a seed-data import. Explicit follow-up F1 in brainstorm. |
| Live count preview on slider drag | Cool but every drag tick fires aggregation queries. Defer; revisit if users ask. |

## Open Questions (for `/deepen-plan` to chase)

1. The audio module landing page (`/audio` or equivalent index) — does it surface cross-deployment counts that should respect threshold? Need to confirm during Phase 2.
2. Does the cron `nightly-refresh` job aggregate any detection counts that get persisted? Repo research said no, but worth a second look.
3. Are there any Slack/email notifications that quote detection counts? If so, decide whether to thread threshold through or always show raw.
4. Do we want a "compare modes" view (side-by-side at two thresholds)? Probably defer.
5. Should the export include a methods sidecar (`README.txt`) describing the threshold and citation? Brainstorm flagged this as open.

## References & Research

### Internal
- Brainstorm: `docs/brainstorms/2026-05-13-birdnet-confidence-threshold-filtering-brainstorm.md`
- Schema: `src/db/schema.ts:825-843` (audio_identifications, verificationStatus enum)
- Existing queries (must be updated):
  - `src/app/audio/actions.ts:154-178` (deployment counts)
  - `src/app/audio/actions.ts:292` (file detection counts)
  - `src/app/audio/actions.ts:584-599` (post-job stats — note: keep raw)
  - `src/app/audio/[id]/page.tsx:182-192` (birdnetStats)
  - `src/app/audio/[id]/annotate/[fileId]/page.tsx:63-97` (annotation list)
- Existing slider primitives: `@radix-ui/react-slider 1.3.6` in deps (no shadcn wrapper yet)
- localStorage precedents: `src/lib/spectrogram-settings.ts`, `src/app/audio/[id]/annotate/[fileId]/spectrogram-controls.tsx`
- URL searchParams precedent: `src/app/audio/indices/page.tsx:15-17,97-98`
- CSV export precedent: `src/app/api/camera-trap/export/route.ts:35-54`

### Institutional learnings (from `docs/solutions/`)
- Audio routes use `grabaciones` project ID, **not** `camera-trap` — `docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md`.
- Keep Drizzle queries synchronous (no `await db.transaction(async ...)`) — `docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md`. Not directly applicable here (no transactions) but reinforces sync query style.
- ODK-style fallback chain pattern — not relevant, but cited as the project's style for evolving schemas.

### External
- **Tebbutt et al. (2026, in review)** — the paper that motivated this. Provides species-specific 95% thresholds and the population median used for our 0.7 default.
- **Wood, C. M. & Kahl, S. (2024).** Guidelines for appropriate use of BirdNET scores and other detector outputs. *Journal of Ornithology*, 165(3), 777–782. https://doi.org/10.1007/S10336-024-02144-5 — cited in the slider tooltip and CSV header documentation.
- **Pérez-Granados (2023).** BirdNET: applications, performance, pitfalls and future opportunities. *Ibis*, 165(3), 1068–1075.
- **Radix UI Slider** docs (consulted at implementation time).

### CLAUDE.md conventions applied
- Spanish UI strings (slider tooltip, toggle label, export button label).
- `ActionResult<T>` discriminated union for server-action returns.
- `requirePermission(projectId, 'viewer')` on all read actions.
- Module-level DB singleton (no `globalThis`).
- No `as string` casts on `FormData.get()`.
