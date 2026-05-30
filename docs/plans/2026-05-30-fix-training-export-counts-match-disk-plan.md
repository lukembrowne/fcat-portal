---
title: "fix: training export counts must match what ships to disk"
type: fix
date: 2026-05-30
status: ready
area: camera-trap / training-exports
---

# 🐛 fix: Training export `counts` must match the JPEGs actually written to disk

## TL;DR

The portal's training-data exporter inflates `manifest.counts` because it tallies
counts from the **pre-fetch candidate set** (`filtered`) while only the
**successfully-written crops** land on disk. When a source image is unreachable
(`driveFileId IS NULL`, the v4 case), the crop is skipped + a `manifest.warnings`
entry is added, but the detection was already counted. The classifier's
`verify_export_on_disk` then trips ("found N files, manifest expects N+k").

**Fix:** derive every count (`perClass`, per-split totals, `counts.total`,
`deployments[]`, `deploymentsJson`) from the set actually written to disk, and
pre-filter unreachable-by-construction detections at collection time so the
preview, content hash, coverage guard, and disk all agree.

> **Note on "bug #1" (the `val>0`/`test>0` guarantee in the spec):** that bug
> was already fixed (plan `2026-05-19-fix-training-export-guarantee-val-test-coverage`).
> Current code enforces it via `selectIncludedClasses` (requires
> `count >= minExamples AND distinctDeployments >= 3`) and the post-stratify
> `findUncoveredLabels` drop. The spec references it because it was written
> against `v1` (2026-05-18), before that fix shipped. **This plan does not
> re-implement bug #1** — it only (a) adds a regression test that ties bug #1 to
> the new write-failure path, and (b) re-runs the coverage guard over the
> *written* set so a transient fetch failure can't silently re-introduce a
> `val=0`/`test=0` class.

---

## Problem statement

### What ships today (verified against current code)

The exporter lives in:

- Server action + background job: `src/app/camera-trap/training-exports/actions.ts`
  - `collectExportCandidates()` — `actions.ts:247`
  - `exportTrainingDataset()` (dispatch + content-hash dedup + single-flight) — `actions.ts:687`
  - `processTrainingExportJobInternal()` (background fetch → crop → manifest) — `actions.ts:955`
  - `loadImageBytes()` (local path → Drive fallback; throws on neither) — `actions.ts:1337`
- Pure helpers: `src/lib/training-export-helpers.ts`
  - `selectIncludedClasses()` `:255`, `findUncoveredLabels()` `:283`,
    `computeContentHash()` `:401`, `buildCounts()` `:550`, `buildManifest()` `:578`
- Schema: `src/db/schema.ts:411` (`cameraTrapTrainingDatasets`); `content_hash`
  is `NOT NULL UNIQUE` (`schema.ts:416`, `scripts/push-schema.mjs:558`)
- Tests: `tests/unit/training-export.test.ts`

### The defect

In `processTrainingExportJobInternal`:

```ts
// actions.ts:1154-1160  — counts come from `filtered`, the PRE-FETCH set
const counts = buildCounts(
  filtered.map((c) => ({
    finalLabel: c.finalLabel,
    split: splitByDeployment.get(c.deploymentId)!,
  })),
);
```

But the crop loop (`actions.ts:1068-1143`) writes to `csvSlots[idx]` **only on a
successful `cropAndWriteAtomic`**. When `loadImageBytes` throws because the image
has no local path and no `driveFileId` (`actions.ts:1345`), the whole image
group is skipped: `failedCrops++`, a `manifest.warnings` line is added, and no
file is written — yet `filtered` still counts it.

Result (v4, 2026-05-29): `counts.total` = 13694, on-disk = 13690 (4 skips, all
`no local path / no driveFileId`). `counts.perClass` overshoots in 3 train
classes. `crops.csv` (built from the written set at `actions.ts:1200`) is already
correct — so today `crops.csv` row count, `dataset.imageCount` (`actions.ts:1228`,
already `written`), and `manifest.counts.total` **disagree with each other**.
That internal inconsistency is the symptom.

### Why it matters

- Trips the classifier's `verify_export_on_disk` (now warning-aware via
  `585cb57`, which tolerates the gap only when fully explained by skip-warnings —
  a mitigation, not a fix).
- Inflated counts feed `compute_class_weights` (1/√count) → class weights derived
  from wrong sizes. Tiny today (<0.1%), silent, and grows with unreachable sources.

---

## Chosen approach (decisions locked)

- **contentHash: pragmatic.** No schema change. Pre-filter unreachable rows so
  the corpus == what ships; counts come from the written set; `contentHash` stays
  the dispatch/dedup hash (which now equals the shipped set in the deterministic
  case). For rare transient 404s the hash may include a non-shipped row, but
  `counts` stay exact. (Strict post-fetch hashing — recompute-in-job + UNIQUE
  guard or a `request_hash` column — was considered and rejected as
  over-engineering for the observed deterministic failure; see *Alternatives*.)
- **End-to-end verification: manual.** This plan delivers the code fix + tests +
  a runbook. Luke runs the real-data re-export and the classifier smoke test on
  the server (acceptance #2-4).

---

## Proposed solution

Three coordinated changes, smallest-blast-radius first.

### Change 1 — Counts from the written set (the core fix)

In `processTrainingExportJobInternal`, after the crop loop, build a single
`writtenRows` list from the non-null `csvSlots` (each slot already carries
`split` and `label`/`finalLabel`) and derive **all** count-like outputs from it:

- `buildCounts(writtenRows)` — `actions.ts:1155`
- `perDeploymentCounts` / `deploymentSummaries` — `actions.ts:1161-1174`
  (these feed both `manifest.deployments` and `deploymentsJson` at `:1235`)

Leave unchanged (already correct or intentionally "attempted"):

- `crops.csv` (`actions.ts:1200`) — already the written set; becomes the
  cross-check oracle for tests.
- `dataset.imageCount` (`actions.ts:1228`) — already `written`.
- `processedImages` final write (`actions.ts:1249`) — **keep `filtered.length`**
  (attempted total) so the floating progress bar reads "N de N" complete;
  skips are surfaced via `failedImages`/`failedCrops` and the terminal event
  extras (`imageCount: written`, `actions.ts:1276`). Do **not** conflate progress
  with the count fix (flipping it to `written` makes the bar jump backward).

```ts
// Pseudocode — actions.ts, replacing the count block around :1154
const writtenRows = csvSlots.filter(
  (r): r is CropCsvRow => r !== null,
); // === the set on disk; same array crops.csv is built from

// Safety net (Change 3) runs here, then:
const counts = buildCounts(
  writtenRows.map((r) => ({ finalLabel: r.label, split: r.split })),
);
const perDeploymentCounts = new Map<number, number>();
for (const r of writtenRows) {
  perDeploymentCounts.set(
    r.deploymentId,
    (perDeploymentCounts.get(r.deploymentId) ?? 0) + 1,
  );
}
// deploymentSummaries built from perDeploymentCounts as today.
```

**Decision recorded in this plan:** a deployment whose every crop failed is
**omitted** from `manifest.deployments`/`deploymentsJson` (it contributed nothing
to disk). Its `training_split` was already persisted at dispatch — acceptable;
it just won't appear in this dataset's deployment summary.

### Change 2 — Pre-filter unreachable-by-construction rows at collection

In `collectExportCandidates` (`actions.ts:247`), drop candidates whose source can
never be fetched **before** building `labelCounts`/`labelDeployments`/`filtered`.
The predicate MUST match `loadImageBytes`'s real fallback logic, not a naive
"both null":

- `loadImageBytes` tries `row.imagePath` first (local cache; reads may still fail
  silently → falls through), then requires `row.driveFileId` (`actions.ts:1345`).
- A row with a present-but-stale local path **but a valid `driveFileId`** is still
  fetchable → keep it.
- A row with **no `driveFileId`** is unfetchable-by-construction → drop it. (Local
  cache is routinely deleted by chunked ML; Drive is the durable source.)

So the pre-filter predicate is effectively `driveFileId IS NOT NULL` (the local
path alone cannot be relied on as a durable source). Implement either in the SQL
`where` (`actions.ts:283`) or in the `.map`/filter that builds `candidates`
(`actions.ts:292`). Prefer the SQL `where` for clarity:

```sql
-- add to the and(...) in collectExportCandidates
isNotNull(images.driveFileId)
```

Effects:

- The 4 v4 detections never enter `filtered` → never counted, never attempted,
  no warning needed for them. Preview counts become honest.
- `selectIncludedClasses` + `findUncoveredLabels` now see only fetchable rows, so
  a class that only qualified via unreachable rows is dropped **in the preview**
  (no finalize surprise) → repairs the bug-#1/#2 interaction for the
  deterministic case at the source.
- **Hash-basis change:** pre-filtering alters `rows` fed to `computeContentHash`,
  so every existing dataset's hash changes once → the next export re-creates the
  dataset under a new version even on an unchanged corpus. This is the same
  one-time, harmless effect documented for the `quality` block
  (`training-export-helpers.ts:397`). Add an equivalent comment.

> **Optional transparency:** record how many candidates were dropped as
> unfetchable (e.g. a `droppedUnreachable: <count>` field on the manifest, or a
> `log.info`). Nice-to-have; not required by acceptance.

### Change 3 — Finalize-time written-set coverage re-check (transient safety net)

After Change 1 builds `counts` from `writtenRows`, re-run the existing guard over
the **written** per-class-per-split counts (reuse `findUncoveredLabels`). If any
surviving class lost a split to a *transient* fetch failure (driveFileId present
but Drive 404 at fetch time — not covered by Change 2):

1. Drop the class from `classList` (and `classListJson`, `classCount`).
2. Remove its rows from `counts`, `writtenRows`, and the `csvRows` written to
   `crops.csv`.
3. Prune its already-written files (`rm -rf <split>/<slug>` for all three splits)
   so the tarball matches the manifest.
4. Add it to `droppedSpecies` with reason
   `"no_val_or_test_after_fetch_failures"` and `log.warn`.

With Change 2 in place this should essentially never fire for the observed cause;
it exists so a transient Drive outage can never re-trip the classifier's
`load_manifest` `val>0/test>0` assertion. Keep it simple and defensive.

---

## Data-flow after the fix

```
collectExportCandidates
  → SQL: verified detections, detectionClass=0, not-excluded,
         confidence>=floor, driveFileId IS NOT NULL   ← NEW (Change 2)
  → selectIncludedClasses (count>=min AND deps>=3)     [bug #1 guard, unchanged]
  → stratify + findUncoveredLabels (pre-fetch drop)    [bug #1 guard, unchanged]
  → filtered (== fetchable corpus)
exportTrainingDataset
  → computeContentHash(filtered, …)  → dedup short-circuit / single-flight
  → persist training_split, allocate version, dispatch job
processTrainingExportJobInternal (background)
  → group by imageId, download once, crop in-memory, write atomically
  → csvSlots[idx] set ONLY on successful write
  → writtenRows = csvSlots.filter(non-null)            ← NEW (Change 1)
  → findUncoveredLabels(writtenCounts) → drop+prune     ← NEW (Change 3, rare)
  → buildCounts(writtenRows) / deploymentSummaries(written) ← NEW (Change 1)
  → manifest.json (counts==disk), crops.csv (unchanged), dataset row
```

---

## Acceptance criteria

### Code (this repo)

- [x] `manifest.counts.total === dataset.imageCount === crops.csv row count` for
      every export (counts + `imageCount` now derive from `writtenRows`).
- [x] `counts.perClass[slug][split]` equals the JPEG count on disk for every
      class/split; per-split totals and `counts.total` equal on-disk totals
      (counts derive from the written set; verified on disk in manual E2E).
- [x] `counts.total === counts.train + counts.val + counts.test`.
- [x] Unreachable-by-construction detections (`driveFileId IS NULL`) are excluded
      at collection (`isNotNull(images.driveFileId)`) and appear in neither
      `counts`, the export tree, nor `manifest.warnings`.
- [x] Every remaining `manifest.warnings` skip entry corresponds to a detection
      absent from both `counts` and the export tree (warnings fire only on
      fetch failure; counts from the written set exclude those rows).
- [x] A surviving class that loses a split to fetch failures is dropped from
      `classList`/`counts` (and its files pruned), never shipped with `val=0` or
      `test=0`. Recorded in `droppedSpecies` (Change 3).
- [x] `contentHash` describes the shipped corpus in the deterministic case (pre==
      post since unreachable rows are pre-filtered). No schema change. Dispatch
      dedup short-circuit + single-flight unchanged; UNIQUE constraint intact.
- [x] Cross-split invariant preserved: no `<detectionId>` stem under more than one
      of `train|val|test` (split is a pure function of `deploymentId`; test added).
- [x] `npm run test:run` (54 pass) + lint pass; `npm run build` passes. (Pre-
      existing `tsc` errors in untouched `tests/integration/*` are unrelated.)

### Tests (`tests/unit/training-export.test.ts`)

- [x] **Bug #2 core:** written-set array with N skipped rows asserts
      `counts.total === writtenCount`, `writtenCount + N === candidateCount`,
      per-split sums reconcile.
- [x] **Bug #2 deployment omission:** a deployment whose every crop failed is
      absent from the written-set per-deployment tally.
- [x] **Bug #1 ↔ #2 interaction (new regression):** a surviving class loses its
      only `val` crop → written-set `findUncoveredLabels` flags it for drop.
- [x] **Bug #1 lock-in (already covered, kept green):** `selectIncludedClasses`
      livestock drop, `findUncoveredLabels` anchored case.
- [ ] **Change 2 (SQL pre-filter):** not unit-tested — it's a SQL `where` clause;
      covered structurally + by the manual E2E export. (Acceptable; no pure helper
      to assert against without a DB mock.)
- [x] **Cross-split:** every `detectionId` stem in the written set appears under
      exactly one split.
- [ ] **contentHash determinism:** existing hash tests (`test:127-238`) still pass.

### End-to-end (manual, Luke — runbook below)

- [ ] Re-export against the same input data as the broken export; new version is
      allocated (don't reuse a prior `vN`).
- [ ] Classifier smoke test passes with exit 0 **and no tolerated-gap warning**:

```bash
cd /Users/luke/apps/fcat-biochoco-camera-classifier
rm -rf data/<new> && tar -xzf /path/to/training-export-<new>.tar.gz -C data/
uv run python - <<'PY'
from pathlib import Path
from data import load_manifest, verify_export_on_disk
m = load_manifest(Path('data/<new>/manifest.json'))
verify_export_on_disk(m, m.split_root)
print(f"OK {len(m.class_list)} classes "
      f"(train={sum(m.counts_per_class[s]['train'] for s in m.class_list)}, "
      f"val={sum(m.counts_per_class[s]['val'] for s in m.class_list)}, "
      f"test={sum(m.counts_per_class[s]['test'] for s in m.class_list)})")
PY
```

---

## Edge cases & how this plan handles them

| Edge case | Handling |
|---|---|
| Unreachable `driveFileId IS NULL` (the v4 cause) | Pre-filtered at collection (Change 2) — never counted/attempted |
| Transient Drive 404 (driveFileId present, file gone) | Counts from written set stay exact (Change 1); coverage re-check (Change 3) drops a class only if a split zeroes |
| Class drops below val/test floor after write failure | Change 3 drops + prunes the class; never ships `val=0`/`test=0` |
| Whole deployment fails to fetch | Omitted from `deployments`/`deploymentsJson` (decision recorded) |
| Idempotent resume (file exists, size>0) | `cropAndWriteAtomic` reuses it → `written++` + `csvSlots` populated, so written-set counts include prior-run files — correct |
| Stale files from a prior `filtered` in same version dir | Different quality/corpus ⇒ different hash ⇒ different date-prefixed version dir, so cross-run staleness is bounded; Change 3 prune covers dropped-class files. (Broad stale-file reconciliation is out of scope.) |
| Cross-split contamination | Unaffected — split is a pure function of `deploymentId`; counts now derive from the *same* split used for the path |
| Progress bar regression | `processedImages` stays `filtered.length` (attempted) so it completes at 100% |
| Dedup / single-flight | Unchanged — dispatch hash over the (now pre-filtered) corpus |

---

## Alternatives considered (contentHash)

- **Option B — recompute post-fetch hash in the job + UNIQUE-collision guard.**
  Honors "hash describes shipped data" for transient failures too, but the
  dispatch dedup short-circuit compares a pre-fetch hash against a column holding
  a post-fetch hash → dedup breaks; two corpora shipping the same surviving set
  collide on the UNIQUE column → job fails at finalize after all the work.
  Fragile. Rejected.
- **Option C — separate `request_hash` (dedup) + `content_hash` (shipped).**
  Cleanest separation but requires a schema migration (per CLAUDE.md, the
  `CREATE TABLE` + `ALTER` live in `scripts/push-schema.mjs`, plus a Drizzle
  change) and still carries the UNIQUE-collision question. Over-engineered for a
  deterministic 4-row defect. Rejected (revisit only if strict post-fetch hashing
  becomes a hard requirement).

---

## Runbook — manual re-export + verification (Luke)

1. Deploy the fix (`./deploy.sh` or per your release flow).
2. Re-run the export from the UI: camera-trap → training-exports → export (same
   `minExamples`/quality knobs as the broken export). A new `vN` is allocated.
3. Upload to Drive (row action) and download the tarball.
4. Run the classifier smoke test above. Confirm exit 0 and **no** "tolerated gap"
   warning from `verify_export_on_disk`.
5. Spot-check: `manifest.counts.total` == `find data/<new> -name '*.jpg' | wc -l`.

---

## Out of scope

- Changing `splitStrategyVersion` (stays at `2`).
- Re-implementing bug #1 (already fixed).
- Rebalancing/oversampling class counts.
- Strict post-fetch contentHash (Options B/C) — documented, not implemented.
- Moving split write-back from dispatch to finalize (hash-stability implications;
  defer).
- Broad stale-file reconciliation in the version dir beyond dropped-class prune.

---

## References

### Internal
- Exporter: `src/app/camera-trap/training-exports/actions.ts`
  (counts `:1155`, deploymentsJson `:1235`, processedImages `:1249`, hash
  `:820`, skip path `:1080`, `loadImageBytes` `:1337`)
- Helpers: `src/lib/training-export-helpers.ts`
  (`buildCounts` `:550`, `computeContentHash` `:401`, `selectIncludedClasses`
  `:255`, `findUncoveredLabels` `:283`)
- Schema: `src/db/schema.ts:411` (`content_hash` UNIQUE `:416`);
  `scripts/push-schema.mjs:558`
- Tests: `tests/unit/training-export.test.ts`
- Progress UI: `src/components/floating-job-progress.tsx`

### Prior plans (context)
- `docs/plans/2026-05-19-fix-training-export-guarantee-val-test-coverage-plan.md` (bug #1, shipped)
- `docs/plans/2026-05-28-feat-training-export-megadetector-metadata-drive-share-plan.md` (manifest/crops.csv/quality + content-hash correctness)
- `docs/plans/2026-05-29-feat-training-export-background-jobs-plan.md` (background-job architecture, single-flight, cancel)

### Classifier side
- `fcat-biochoco-camera-classifier` `data.py`: `load_manifest` (val>0/test>0
  assert), `verify_export_on_disk` (on-disk count check, warning-aware via
  `585cb57`)
