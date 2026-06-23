---
title: "feat: Inline per-class/per-split count deltas vs last export in training-export preview"
type: feat
date: 2026-06-23
status: ready
area: camera-trap / training-exports
---

# ✨ Inline count deltas vs the last export in the training-export preview

## Overview

In the camera-trap **Exportes de Entrenamiento** module, the "Vista previa — umbral N"
card (the **"Crear nuevo exporte"** block) renders a per-species table:
`Especie · Train · Val · Test · Total`, where each cell shows a crop count plus
`(N)` distinct installations.

This feature adds an **inline delta** (`+25` / `−10`) next to each species × split
count, comparing the **current preview's candidate counts** against the
**per-class/per-split counts of the most recent completed export**. The goal: at a
glance, see *how much data we are adding (or losing) per class and split* since the
last export, before committing to a new one.

**Scope (decided with the user):**
- **Surface:** only the `PreviewCard` per-species table in
  `src/app/camera-trap/training-exports/export-form.tsx` (the screenshot table). Not the
  Historial table, not a standalone comparison view.
- **Baseline:** the single **latest completed export overall** (highest `id` in
  `camera_trap_training_datasets`).

## Problem statement / Motivation

Today the preview shows the prospective export's counts in isolation. The whole point of
re-exporting is that new verified detections have accumulated since last time — but the
operator has **no way to see how much** without manually opening the previous export's
`manifest.json` and eyeballing it class by class. An inline `+N` per cell turns "is it
worth re-exporting yet?" and "which classes grew?" into a one-glance read.

## Key technical fact (drives the whole design)

The DB row `camera_trap_training_datasets` (`src/db/schema.ts:417-444`) **does not store
per-class/per-split counts**. It stores `imageCount`, `classCount`, `classListJson`,
`droppedSpeciesJson`, and `deploymentsJson` (per-deployment split totals — *not*
decomposable per class). The full `counts.perClass[folderName].{train,val,test}` map
lives **only in the on-disk `manifest.json`**, built by `buildCounts()`
(`src/lib/training-export-helpers.ts:550-571`) and written via `buildManifest()` to the
row's `manifestPath`.

**Decision — read the baseline from disk, no schema migration.** To get the baseline
per-class/per-split counts, read the latest completed dataset's `manifest.json` via its
`manifestPath` and parse `counts.perClass`. This reuses the **exact disk-read pattern
already proven** in `needsSplitStrategyMigration` (`actions.ts:503-535`,
`JSON.parse(await fs.readFile(latest[0].manifestPath, ...))` inside a try/catch). The
baseline is a single small file read per preview — persisting a `perClassCountsJson`
column is unnecessary for this surface and would add an `ALTER TABLE` migration
(`scripts/push-schema.mjs` + `src/db/schema.ts`; see *Alternatives*). Disk-read it is.

## Proposed solution

Three changes, smallest blast radius first.

### Change 1 — `getExportPreview` returns a `baseline` block

In `src/app/camera-trap/training-exports/actions.ts`, after building the current
`ExportPreview`, load the latest completed dataset and attach its counts:

```ts
// actions.ts — inside getExportPreview(), after current perSpecies is built
// Baseline = latest completed export overall. Dataset rows are inserted ONLY on
// successful finalize, so every row is a completed export → max(id) is the latest.
const latest = await db
  .select({ version: d.version, createdAt: d.createdAt,
            minExamplesThreshold: d.minExamplesThreshold, manifestPath: d.manifestPath })
  .from(cameraTrapTrainingDatasets)
  .orderBy(desc(cameraTrapTrainingDatasets.id))
  .limit(1);

let baseline: ExportPreviewBaseline | null = null;
if (latest[0]?.manifestPath) {
  try {
    const raw = await fs.readFile(latest[0].manifestPath, "utf8");
    const manifest = JSON.parse(raw) as { counts?: ManifestCounts };
    if (manifest.counts?.perClass) {       // shape guard — old/partial manifests degrade
      baseline = {
        version: latest[0].version,
        createdAt: latest[0].createdAt,
        minExamplesThreshold: latest[0].minExamplesThreshold,
        counts: manifest.counts,            // { total, train, val, test, perClass }
      };
    }
  } catch (err) {
    log.warn("training-export preview: baseline manifest unreadable", { err });
    baseline = null;                        // degrade: no deltas, card still renders
  }
}
return { success: true, data: { ...preview, baseline } };
```

- `ExportPreview` gains `baseline: ExportPreviewBaseline | null`. The `baseline` shape is
  plain JSON (numbers/strings) — safe to serialize Server→Client.
- **Never throws to the card.** Null `manifestPath`, missing file (dir pruned / fresh
  container / volume not mounted), malformed JSON, or a legacy manifest without
  `counts.perClass` all resolve to `baseline = null` (deltas suppressed, current counts
  still shown). This is the highest-risk failure mode (manifests live on disk, not DB) —
  the try/catch + shape guard is the mitigation.
- **Umbral re-fetch:** the baseline is always "latest completed," independent of the
  umbral slider, so re-resolving it per debounced preview call returns the same export —
  re-reading one small file is acceptable. (Optional micro-opt: memoize by
  `manifestPath`; not required.)

### Change 2 — pure diff helper (unit-testable)

Add to `src/lib/training-export-helpers.ts`:

```ts
export interface PreviewDeltaRow {
  folderName: string;                 // speciesFolderName key (diff key)
  label: string;                      // display label (current row's, or baseline-derived for ghosts)
  current: { train: number; val: number; test: number; total: number;
             trainDeps?: number; valDeps?: number; testDeps?: number };
  delta:   { train: number; val: number; test: number; total: number };
  status: "changed" | "new" | "removed";  // new = absent in baseline; removed = absent now
}

/**
 * Merge the current preview's per-species rows with the baseline manifest's
 * counts.perClass, keyed by speciesFolderName. Returns one display row per
 * folder name present in EITHER side, plus footer totals deltas.
 * Pure — no DB/FS.
 */
export function buildPreviewDeltas(
  perSpecies: ExportPreviewSpeciesRow[],
  baseline: ManifestCounts | null,
): { rows: PreviewDeltaRow[]; footer: { train: number; val: number; test: number; total: number } | null } {
  // 1. Aggregate current rows by speciesFolderName(label) FIRST (defensive: two labels
  //    could normalize to one folder — never double-count or mis-key).
  // 2. For each folder in (current ∪ baseline.perClass):
  //      current = aggregated current or zeros; base = baseline.perClass[folder] or zeros
  //      delta.split = current.split − base.split   (per split, independently)
  //      status = base-absent ? "new" : current-absent ? "removed" : "changed"
  // 3. footer = baseline ? { split: currentTotal.split − baseline.split } : null
  //    (total−total; equals sum of row deltas because ghost rows are included)
}
```

- **Per-split deltas are independent** (a deployment moving splits yields e.g.
  `train +25 / val −25`). A split key missing from baseline → treat as `0` (never `NaN`).
- **New species** (`status:"new"`): baseline 0 → delta == full current count.
- **Removed species** (`status:"removed"`): present in baseline, absent now → a **ghost
  row** with `current = 0` and negative deltas, so "data removed per class" is visible and
  **the body deltas sum to the footer delta** (footer = total−total).
- **Folder-name collisions**: handled by aggregating current rows by `speciesFolderName`
  before diffing.

### Change 3 — render deltas in `PreviewCard`

In `export-form.tsx` (`PreviewCard`, lines ~288-470):

- Call `buildPreviewDeltas(preview.perSpecies, preview.baseline?.counts ?? null)` and
  render its `rows` (current species first, then `removed` ghost rows muted at the
  bottom). Footer/totals row uses `footer` deltas.
- **Cell layout** (avoid the unreadable `123 (+25) (4)`): keep the existing `count (N)`
  exactly, then append the delta as a distinct, smaller, colored token:
  `2.242 (49)  ▸ +120`. Suppress the token entirely when delta is `0` (no `+0`/`−0`
  noise) and when `baseline == null`.
- **Sign + locale:** format the magnitude with `Intl.NumberFormat("es-EC")`, then prepend
  the sign **manually** (`+` / `−`, using U+2212 for minus consistently) — do **not** rely
  on the locale's negative formatting (it would emit `-` and never `+`).
- **Color:** green for `+`, red for `−`. Always keep the sign glyph (do not rely on color
  alone — accessibility). Add a one-line legend/caption.
- **New species:** small Spanish badge `nuevo` next to the row; its deltas read `+N`.
- **Baseline context header** (resolves the candidate-vs-written + umbral-mismatch
  ambiguity, per SpecFlow): under the existing "Vista previa — umbral N" header, add e.g.
  `Δ vs. último exporte v{version} · {DD/MM/YYYY} · umbral {M}` so the operator knows
  exactly what the deltas compare against. When `baseline == null`, show instead a muted
  `Sin exporte previo para comparar` (or `Manifiesto no disponible` to distinguish a
  present-but-unreadable manifest, for diagnosability).
- **Delta tooltip:** on hover, show the previous value (`Antes: 2.122`) using the
  **Radix/shadcn `Tooltip`** (`src/components/ui/tooltip.tsx`, `TooltipProvider
  delayDuration={150}`) — **never the native `title` attribute** (documented unreliable on
  this very page: `docs/solutions/ui-bugs/native-title-tooltip-not-rendering-TrainingExports-20260514.md`).

## Technical considerations

- **Candidate-vs-written semantic gap (honesty).** Preview counts *candidates* (live DB);
  the baseline manifest counts *what was written to disk* at that export. With the
  `driveFileId IS NOT NULL` pre-filter (`2026-05-30` fix) candidate ≈ written in the
  deterministic case, so deltas are meaningful. But if the current umbral differs from the
  baseline's umbral, part of the delta is threshold noise, not added data. **Mitigation:**
  label the column "vs. último exporte" (never "nuevos candidatos") and surface the
  baseline's umbral in the header so the number is interpretable. Documented as a known
  approximation, not a bug.
- **Diff key correctness.** Current rows key on `correctedSpecies ?? species`; baseline
  `perClass` keys on `speciesFolderName(label)`. The helper normalizes current rows through
  `speciesFolderName` before diffing. A species re-corrected since the baseline may appear
  as simultaneous `new` + `removed` rows — acceptable and self-explanatory.
- **`biochoco_*` tables.** The current-side counts already come from the live
  `collectExportCandidates` query over `biochoco_detections/images/identifications/deployments`
  (no change). We are only *reading a manifest file* for the baseline — no new count query.
- **No schema migration, no transaction.** Disk read only. (If we ever persist counts:
  `ALTER TABLE` in `scripts/push-schema.mjs` + `src/db/schema.ts`, and any insert stays a
  **synchronous** better-sqlite3 transaction — out of scope here.)
- **Server→Client serialization.** `baseline` is plain JSON; safe as a prop.

## Implementation outline (files)

1. `src/lib/training-export-helpers.ts`
   - Export `PreviewDeltaRow`, `ExportPreviewBaseline` (if co-located), and the pure
     `buildPreviewDeltas(perSpecies, baseline)`.
2. `src/app/camera-trap/training-exports/actions.ts`
   - Extend `ExportPreview` with `baseline: ExportPreviewBaseline | null`.
   - In `getExportPreview`: load latest dataset (`orderBy desc(id) limit 1`), read +
     parse its `manifest.json` (try/catch + `counts.perClass` shape guard), attach
     `baseline`. Reuse the `needsSplitStrategyMigration` read pattern (`:503-535`).
3. `src/app/camera-trap/training-exports/export-form.tsx`
   - `PreviewCard`: compute rows via `buildPreviewDeltas`, render inline delta tokens
     (sign + es-EC + color + suppress-zero), ghost rows for `removed`, footer deltas,
     baseline-context header, Radix tooltip, `nuevo` badge.
4. `tests/unit/training-export.test.ts`
   - Unit tests for `buildPreviewDeltas` (below).

## Acceptance criteria

### Functional
- [x] With a prior export present and its manifest readable, each species × split cell in
      the preview shows `count (N)` plus an inline `+N`/`−N` delta vs the latest completed
      export; `0` deltas render nothing.
- [x] Per-split deltas are computed independently (a split-mix shift shows e.g.
      `train +25 / val −25`). *(unit-tested)*
- [x] A species present now but absent in the baseline shows full count as `+N` with a
      `nuevo` badge. *(unit-tested)*
- [x] A species present in the baseline but absent now appears as a muted **ghost row**
      with `0` and negative deltas (removals visible). *(unit-tested)*
- [x] Footer/totals row shows per-split and grand-total deltas (baseline total − current
      total), and the body deltas sum to the footer. *(unit-tested)*
- [x] A header line states the comparison basis: `Δ vs. último exporte v{version} ·
      {fecha} · umbral {M}`.

### Degradation / robustness
- [x] No prior export → no deltas; muted `Sin exporte previo para comparar`; card renders
      normally.
- [x] `manifestPath` null/empty, file missing, malformed JSON, or manifest lacking
      `counts.perClass` → `baseline = null`, deltas suppressed, **card never crashes**;
      a warning is logged. *(shape guard + try/catch in `loadBaselineExport`)*
- [x] Changing the umbral re-fetches the preview but the baseline still resolves to the
      same latest completed export (no per-keystroke baseline flicker). *(baseline =
      `ORDER BY id DESC LIMIT 1`, independent of the umbral param)*

### Quality
- [x] Delta tooltips use the Radix `Tooltip` component, not the native `title` attribute.
- [x] Sign is explicit (`+`/`−` U+2212), magnitude formatted `es-EC`; never `NaN`, never `+0`.
- [x] Color is not the sole signal (sign glyph always present); a one-line legend exists
      (`+más / −menos` in the header).
- [x] `buildPreviewDeltas` is pure and unit-tested; `npm run test:run` (1252 pass),
      `eslint`, `npm run build` green.

## Edge cases (from SpecFlow analysis)

| Edge case | Handling |
|---|---|
| No prior completed export | `baseline = null` → suppress deltas + muted note |
| `manifestPath` null / file missing / malformed / legacy (no `counts.perClass`) | try/catch + shape guard → `baseline = null`, log warn, card renders |
| New species (now, not in baseline) | `status:"new"`, delta == full count, `nuevo` badge |
| Removed species (baseline, not now) | ghost row, `0` + negative deltas (body sums to footer) |
| Split mix changes for a species | per-split deltas computed independently; missing split = 0 |
| `speciesFolderName` collisions | aggregate current rows by folder name before diffing |
| Re-correction since baseline shifts key | shows as new + removed pair (acceptable, self-evident) |
| Candidate-vs-written / umbral mismatch | label "vs. último exporte" + show baseline umbral in header |
| Zero delta | render nothing (no `+0`/`−0`) |
| Locale negatives | format magnitude es-EC, prepend sign manually (U+2212) |
| Umbral re-fetch | baseline independent of umbral → stable |
| `(N)` installations figure | **no** delta on `(N)` (count delta only) to keep cells readable |

## Testing

- **Unit (`tests/unit/training-export.test.ts`) — `buildPreviewDeltas`:**
  - changed-only: matching folders, correct per-split + total deltas.
  - new species (baseline absent) → `status:"new"`, delta == current.
  - removed species (current absent) → ghost row, negative deltas.
  - split-mix shift: `train +k / val −k`, total delta 0.
  - missing split key in baseline → 0, not NaN.
  - folder-name collision: two labels → one aggregated row.
  - `baseline == null` → no deltas, `footer === null`.
  - footer == sum of row deltas (incl. ghosts).
- **Manual (Luke):** open the preview with a real prior export present; confirm deltas
  match (spot-check one class against `manifest.json`); rename/move the latest manifest →
  confirm graceful degradation (no crash, muted note); change umbral → deltas update,
  header still cites the same baseline version.

## Alternatives considered

- **Persist `perClassCountsJson` on `camera_trap_training_datasets`.** More robust
  long-term and queryable, but for a single-baseline preview surface it adds an
  `ALTER TABLE` migration (`scripts/push-schema.mjs` is `CREATE TABLE IF NOT EXISTS` — a
  no-op on existing DBs; new columns need an explicit `ALTER` with a default, per
  `docs/solutions/database-issues/missing-alter-table-migrations-push-schema.md`) for zero
  added value here. Rejected for now; revisit only if a multi-version comparison view is
  later wanted.
- **Show deltas in the Historial table / a standalone diff view.** Explicitly out of scope
  — the user chose the preview card.

## Out of scope

- Deltas in the Historial table or a standalone version-to-version comparison.
- Persisting per-class counts in the DB.
- Diffing the `(N)` distinct-installations figure.
- Any change to split assignment, counting, or content-hash logic.

## References

### Internal (file:line)
- Preview action + `ExportPreview`/`ExportPreviewSpeciesRow`:
  `src/app/camera-trap/training-exports/actions.ts:138-190`, `getExportPreview` `:550`.
- Proven manifest disk-read pattern: `actions.ts:503-535` (`needsSplitStrategyMigration`).
- Counts model: `src/lib/training-export-helpers.ts:538-571` (`ManifestCounts`,
  `buildCounts`), `speciesFolderName` `:564`, `buildManifest` `:578-628`.
- Dataset table (no per-class counts; `manifestPath`): `src/db/schema.ts:417-444`.
- PreviewCard table to extend: `src/app/camera-trap/training-exports/export-form.tsx:288-470`.
- Radix tooltip: `src/components/ui/tooltip.tsx`.

### Prior plans (context)
- `docs/plans/2026-05-30-fix-training-export-counts-match-disk-plan.md` (counts == disk;
  `driveFileId IS NOT NULL` pre-filter — why candidate ≈ written).
- `docs/plans/2026-05-29-feat-training-export-background-jobs-plan.md` (job model, finalize
  inserts the dataset row).
- `docs/plans/2026-05-28-feat-training-export-megadetector-metadata-drive-share-plan.md`
  (manifest contents).

### Learnings
- `docs/solutions/ui-bugs/native-title-tooltip-not-rendering-TrainingExports-20260514.md`
  (use Radix Tooltip).
- `docs/solutions/database-issues/missing-alter-table-migrations-push-schema.md`
  (why we avoid a column).
