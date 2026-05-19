---
title: Training exporter must guarantee val>0 and test>0 per emitted class
type: fix
date: 2026-05-19
---

# Training exporter must guarantee `val>0` and `test>0` per emitted class

## Overview

The portal's camera-trap training exporter (`src/app/camera-trap/training-exports/actions.ts`) currently emits manifests where some classes pass the `minExamplesThreshold` check but end up with `val=0` and `test=0` after the per-deployment split runs. The downstream classifier (`fcat-biochoco-camera-classifier/data.py:load_manifest`) hard-fails on these manifests because per-class precision/recall/F1 are undefined when support is zero.

Fix it with two coordinated changes:

1. **Primary — a deployment-count pre-filter.** A class needs both `totalExamples ≥ minExamples` AND `distinctDeployments ≥ STRATIFY_MIN_DEPLOYMENTS (3)` to enter `classList`. Reusing the stratifier's existing constant ties inclusion and rebalancing to a single source of truth: any class past inclusion is, by definition, a class the stratifier knows how to balance. (No second constant — see "Why reuse `STRATIFY_MIN_DEPLOYMENTS`" below.)
2. **Defensive — a post-stratify safety drop.** A short check that drops any surviving class still showing zero in any split after stratification. Catches the rare edge case where 3+ deployments are anchored to a single split from a prior export and the stratifier cannot rebalance them.

Both drops land in the existing `droppedSpecies` map — no manifest schema changes, no DB schema changes, no new columns.

## Problem Statement

`training-export-v1.tar.gz` (current production export, content hash `sha256:141c1bb9…`) declares 29 classes. Three have all examples concentrated in `train`:

| slug                              | train | val | test |
|-----------------------------------|------:|----:|-----:|
| `anas_platyrhynchos_domesticus`   | 75    | 0   | 0    |
| `bos_taurus`                      | 51    | 0   | 0    |
| `equus_caballus`                  | 46    | 0   | 0    |

The classifier refuses with:

```
AssertionError: manifest.counts.perClass['anas_platyrhynchos_domesticus']['val'] = 0;
a zero in val/test makes per-class metrics undefined — refuse rather than silently divide by zero
```

The classifier-side assertion is a non-negotiable invariant — the fix must land in the exporter.

### Root cause

Two parameters don't coordinate:

1. **`minExamplesThreshold`** (`actions.ts:217`) — a per-class **total** floor for inclusion (default 50, user-tunable; v1 used 30).
2. **`splitStrategyVersion: 2`** (`training-export-helpers.ts:23`) — per-deployment split via SHA-256 hash bucket (`assignSplit`), then stratified by `stratifyDeploymentSplits` to guarantee 1/1/1 coverage **only for species with ≥ `STRATIFY_MIN_DEPLOYMENTS` (3) deployments** (`training-export-helpers.ts:127`).

Species with `< 3` distinct deployments are seeded by raw hash bucket and never rebalanced. The three offenders are all domestic livestock (duck, cow, horse) that appear at one or two farms — every deployment hosting them happens to land in `train`, and the stratifier won't touch them. The existing `stratifyWarnings` field only catches species that have ≥3 deployments but couldn't be balanced due to anchored splits — it does not flag the low-deployment case.

### Why "just shuffle individual images" is wrong

Reassigning individual detection IDs across splits would break the `splitStrategyVersion: 2` guarantee that camera locations don't leak across splits, and that camera-leak guarantee is the *entire reason* per-deployment splitting exists. Re-stratifying with looser rules is geometrically impossible for 1-deployment species (one camera cannot occupy three splits).

## Proposed Solution

### 1. Deployment-count pre-filter (primary)

Reuse the existing `STRATIFY_MIN_DEPLOYMENTS` constant from `src/lib/training-export-helpers.ts:46` as the inclusion threshold. No new constant.

In `collectExportCandidates` (`actions.ts:209-225`), extend the inclusion check from one condition to two:

- Existing: `labelCounts[label] >= minExamples` → class survives.
- New: AND `deploymentsByLabel[label].size >= STRATIFY_MIN_DEPLOYMENTS` → class survives.

Anything that fails either check goes into `droppedSpecies` (existing field, unchanged shape `Record<string, number>` where the value is the total example count).

The intuition is clean: the stratifier needs ≥3 deployments to balance a class into all three splits; classes below that floor cannot satisfy the classifier's invariant regardless of how many examples they have.

### Why reuse `STRATIFY_MIN_DEPLOYMENTS` instead of introducing a new constant

The inclusion threshold and the rebalancing threshold aren't just coincidentally equal — they're equal *by definition*. If anyone bumps the stratifier threshold to 4 without bumping the inclusion threshold in lockstep, the bug returns: classes with 3 deployments would pass inclusion but the stratifier would no longer try to balance them. One constant, one source of truth. Update the constant's docstring in `training-export-helpers.ts` to make this dependency explicit: "Also used as the per-class minimum-deployments threshold for inclusion in `classList`. These two roles must stay equal — bumping this constant changes both."

### 2. Defensive post-stratify safety drop

After `stratifyDeploymentSplits` runs, walk the per-class-per-split counts one more time. Any class still showing zero in any split (only possible when ≥3 deployments are anchored to the same split from a prior v2 export) is dropped, added to `droppedSpecies`, and logged as a warning. This is the "should never happen" path; it exists so a stale anchor configuration can't silently produce a broken manifest.

### Why both, not just the pre-filter

The pre-filter handles 100% of fresh exports (no anchored deployments yet) and the vast majority of incremental exports. The post-stratify drop exists for a real but rare scenario: 3+ deployments for a species all happen to be anchored to the same split. This can occur if anchoring was set when the species existed on fewer cameras. The defensive drop costs ~10 lines and rules out the "broken export ships and we don't notice until the classifier rejects it" failure mode — which is exactly the bug we're fixing.

### Why both drops go into `droppedSpecies` (no new manifest field)

- The classifier ignores `droppedSpecies` entirely — it only consumes `classList` and `counts.perClass`. The drop bucket is informational, surfaced in the portal UI.
- Keeping the same shape (`Record<string, number>`) means no manifest schema change, no DB schema change, and no client-side serialization concerns for existing v1 rows.
- The semantic distinction ("dropped because of low examples" vs. "dropped because of low deployments" vs. "dropped post-stratify") is captured inside the portal UI by recomputing — we already have all the data on the preview page.

### Why `SPLIT_STRATEGY_VERSION` stays at 2

The split-assignment algorithm is unchanged. The fix only changes which **classes** survive inclusion. Bumping the version would falsely trigger `needsSplitStrategyMigration()` and wipe every persisted `deployments.training_split` for no reason.

The content hash will still differ from v1 because `classList` and the row set shrink. That's correct — v2 is a different (smaller, valid) export of the same corpus and deserves a new hash and a new version row.

### Drop `stratifyWarnings` as a separate surfaced concept

The `stratifyWarnings` field on `ExportPreview` exists today to flag species the stratifier couldn't balance. After this fix, those species are either (a) dropped by the new pre-filter (if they had <3 deployments, they're never in `stratifyWarnings` anyway), or (b) dropped by the defensive post-stratify check (if they had ≥3 but all anchored). Showing both `stratifyWarnings` and the drop list is redundant noise. Remove the `stratifyWarnings` UI panel and the field from `ExportPreview`; surface the same information through the enriched dropped-species panel.

Also filter `forcedReassignments` to omit moves whose label was post-stratify-dropped — otherwise the UI shows "moved camera X to give species Y val coverage" for a Y that didn't survive anyway.

## Technical Approach

### Implementation Phases

#### Phase 1: Update the existing constant's docstring

**File:** `src/lib/training-export-helpers.ts`

No new constant. Update the docstring on `STRATIFY_MIN_DEPLOYMENTS` to make its dual role explicit:

```ts
/**
 * Minimum distinct deployments a class needs for the stratifier to attempt
 * 1/1/1 rebalancing. Also used by the exporter as the per-class inclusion
 * threshold: classes with fewer than this many deployments are dropped
 * into `droppedSpecies` before the stratifier runs.
 *
 * These two roles must stay equal — bumping this constant changes both. If
 * inclusion ever drifts below the stratifier threshold, the exporter will
 * silently ship manifests with val=0 or test=0 for low-deployment classes
 * (the original v1 bug — see docs/plans/2026-05-19-fix-training-export-…).
 */
export const STRATIFY_MIN_DEPLOYMENTS = 3;
```

No new functions, no shape changes. The pre-filter is wired in `collectExportCandidates` (Phase 2) and lives there because it operates on already-collected DB rows.

#### Phase 2: Pre-filter — wire it into `collectExportCandidates`

**File:** `src/app/camera-trap/training-exports/actions.ts`

Replace the inclusion loop at `actions.ts:209-225`:

```ts
// 2. Group by label, drop labels that fail either pre-filter:
//    - total examples below minExamples → not enough signal
//    - distinct deployments below STRATIFY_MIN_DEPLOYMENTS → cannot be
//      balanced into train+val+test even after stratification
const labelCounts = new Map<string, number>();
const labelDeployments = new Map<string, Set<number>>();
for (const c of candidates) {
  if (!c.finalLabel) continue;
  labelCounts.set(c.finalLabel, (labelCounts.get(c.finalLabel) ?? 0) + 1);
  if (!labelDeployments.has(c.finalLabel)) {
    labelDeployments.set(c.finalLabel, new Set<number>());
  }
  labelDeployments.get(c.finalLabel)!.add(c.deploymentId);
}

const classList: string[] = [];
const droppedSpecies: Record<string, number> = {};
for (const [label, count] of labelCounts) {
  const deps = labelDeployments.get(label)?.size ?? 0;
  if (count >= minExamples && deps >= STRATIFY_MIN_DEPLOYMENTS) {
    classList.push(label);
  } else {
    droppedSpecies[label] = count;
  }
}
classList.sort();
```

(Existing comments removed for brevity in this snippet — keep the surrounding documentation in the actual edit.)

Pass `labelDeployments` through (or stash it on `CollectedCandidates`) so the preview UI can show deployment counts next to dropped species.

#### Phase 3: Defensive post-stratify safety drop

**File:** `src/app/camera-trap/training-exports/actions.ts`

In `collectExportCandidates`, after `stratifyDeploymentSplits` returns and before constructing the result, run:

```ts
// 4. Defensive post-stratify drop: if any class still has 0 in any split
//    (only possible when ≥3 anchored deployments collide on one split), drop
//    it gracefully rather than ship a manifest the classifier will reject.
const perLabelSplitCounts = new Map<
  string,
  { train: number; val: number; test: number }
>();
for (const c of filtered) {
  const split = splitByDeployment.get(c.deploymentId);
  if (!split) continue;
  const counts = perLabelSplitCounts.get(c.finalLabel) ?? {
    train: 0,
    val: 0,
    test: 0,
  };
  counts[split] += 1;
  perLabelSplitCounts.set(c.finalLabel, counts);
}

const postStratifyDrops = new Set<string>();
for (const [label, counts] of perLabelSplitCounts) {
  if (counts.train === 0 || counts.val === 0 || counts.test === 0) {
    postStratifyDrops.add(label);
    droppedSpecies[label] = counts.train + counts.val + counts.test;
    log.warn(
      { label, counts },
      "[training-export] post-stratify drop: class survived inclusion but " +
      "stratifier could not give it val+test coverage (likely anchored " +
      "deployments). Dropping from classList.",
    );
  }
}

let survivingClassList = classList;
let survivingFiltered = filtered;
let survivingForcedReassignments = stratified.forcedReassignments;
if (postStratifyDrops.size > 0) {
  survivingClassList = classList.filter((l) => !postStratifyDrops.has(l));
  survivingFiltered = filtered.filter((r) => !postStratifyDrops.has(r.finalLabel));
  survivingForcedReassignments = stratified.forcedReassignments.filter(
    (r) => !postStratifyDrops.has(r.label),
  );
}
```

Return `survivingClassList`, `survivingFiltered`, and `survivingForcedReassignments` from `collectExportCandidates`. The empty-classList guard in `exportTrainingDataset` (`actions.ts:507-512`) already catches the degenerate case where everything drops.

#### Phase 4: Trim `stratifyWarnings` from the public surface

**File:** `src/app/camera-trap/training-exports/actions.ts`

- Remove `stratifyWarnings` from `ExportPreview`.
- Remove `stratifyWarnings: collected.stratifyWarnings` from the `getExportPreview` return.
- Keep the stratifier itself emitting warnings — they're still useful in the `log.warn` line during post-stratify drops to explain *why* a class was dropped.

**File:** `src/app/camera-trap/training-exports/export-form.tsx`

- Remove the `stratifyWarnings` panel (lines 258–271).
- Enrich the dropped-species `<details>` panel (lines 362–376) to show deployment counts alongside example counts. New rendering:

```tsx
<li key={label}>
  <span className="font-mono">{label}</span> — {count} ejemplos en{" "}
  {deploymentsByDropped[label] ?? "?"} instalaciones
</li>
```

Updated summary copy: `"{droppedEntries.length} especies por debajo de los umbrales (≥{minExamples} ejemplos y ≥{STRATIFY_MIN_DEPLOYMENTS} instalaciones)"`.

Pass `deploymentsByDropped: Record<string, number>` through `ExportPreview` so the UI doesn't need to recompute it.

#### Phase 5: Tests

**File:** `tests/unit/training-export.test.ts`

Add three new tests. These can live in a new `describe("inclusion thresholds", ...)` block at the bottom:

1. **Regression — livestock scenario.** Build a synthetic `CollectedCandidates`-shaped input where one species has 75 examples across 2 deployments. Assert the species is in `droppedSpecies` and not in `classList`. Without the fix, this would put the species in `classList`. This is the test that would have caught the v1 bug.
2. **Boundary — exactly 3 deployments.** Species with 3 deployments and 30+ examples → survives inclusion (then stratifier guarantees 1/1/1).
3. **Empty splits after anchoring.** Construct a `splitByDeployment` where a 3-deployment species is anchored to all-`train`. Assert the post-stratify drop kicks in and the species is excluded.

For test scaffolding: the pre-filter logic lives inline in `collectExportCandidates`, which has DB dependencies. Either (a) extract the inclusion check into a small pure helper `selectIncludedClasses({labelCounts, labelDeployments, minExamples, minDeployments})` and test that directly, or (b) test through the action with a mocked DB. Approach (a) is cleaner and faster; do that.

If we extract `selectIncludedClasses`, the test surface is trivial:

```ts
expect(
  selectIncludedClasses({
    labelCounts: new Map([["anas_platyrhynchos_domesticus", 75]]),
    labelDeployments: new Map([["anas_platyrhynchos_domesticus", new Set([1, 2])]]),
    minExamples: 30,
    minDeployments: 3,
  })
).toEqual({
  classList: [],
  droppedSpecies: { anas_platyrhynchos_domesticus: 75 },
});
```

## Alternative Approaches Considered

1. **Post-stratify graceful drop only (no pre-filter).** Original draft of this plan. Works, but moves the "class is unusable" decision downstream from the cleaner intuition ("class needs ≥3 cameras"). Also requires a richer manifest field (`droppedAfterSplit`) and a DB column. Strictly more code for the same outcome.
2. **Deployment-count pre-filter only (no post-stratify check).** Cleaner, but leaves a real failure mode unhandled: 3+ anchored deployments colliding on one split would still produce a broken manifest. The post-stratify check costs ~10 lines and rules this out.
3. **Reassign individual detection IDs across splits.** Rejected — breaks `splitStrategyVersion: 2`'s camera-leak guarantee.
4. **Lower `STRATIFY_MIN_DEPLOYMENTS` from 3 to 1.** Rejected — geometrically impossible for 1-deployment species.
5. **Bump `SPLIT_STRATEGY_VERSION` to 3.** Rejected — would falsely trigger a one-time wipe of every persisted `deployments.training_split`. The split algorithm itself is unchanged.

## Acceptance Criteria

### Functional Requirements

- [x] `STRATIFY_MIN_DEPLOYMENTS` docstring updated to document its dual role (stratifier threshold + inclusion threshold) and the lockstep invariant. No new constant introduced.
- [x] `collectExportCandidates` drops classes with fewer than `STRATIFY_MIN_DEPLOYMENTS` distinct deployments into `droppedSpecies` (alongside the existing `minExamples` filter).
- [x] `collectExportCandidates` runs a defensive post-stratify check; any class still missing coverage in any split is added to `droppedSpecies`, removed from `classList` and `filtered`, with a `log.warn` line naming the class.
- [x] `forcedReassignments` filtered to omit moves for post-stratify-dropped labels.
- [x] `stratifyWarnings` field removed from `ExportPreview`; UI panel removed.
- [x] Preview's dropped-species `<details>` panel shows both example count and deployment count per dropped class, with updated summary copy.
- [x] `selectIncludedClasses` helper extracted and unit-tested.
- [x] `cameraTrapTrainingDatasets` schema unchanged. `scripts/push-schema.mjs` unchanged. No migration.

### Output Contract (manifest invariants — must all hold)

Verified post-deploy by running the export against the real DB and the smoke command below:

- [ ] For every slug in `classList`: `counts.perClass[slug].train > 0 AND counts.perClass[slug].val > 0 AND counts.perClass[slug].test > 0`.
- [ ] `counts.total === counts.train + counts.val + counts.test`.
- [ ] For every slug in `classList`, the directory `<split>/<slug>/` exists with exactly `counts.perClass[slug][split]` JPEGs.
- [ ] No detectionId stem appears in more than one of `train ∪ val ∪ test`.
- [ ] `classList` non-empty, no duplicates, only lower_snake_case slugs.
- [ ] `droppedSpecies` contains `Anas platyrhynchos domesticus`, `Bos taurus`, and `Equus caballus` (each with their total example count).

### Quality Gates

- [x] Regression test for the livestock scenario passes.
- [x] Boundary test (exactly 3 deployments) passes.
- [x] Post-stratify anchored-cameras test passes.
- [x] `docker compose exec portal npm run test:run` passes.
- [x] `docker compose exec portal npm run build` passes.
- [x] `docker compose exec portal npm run lint` passes.
- [ ] End-to-end smoke from the classifier side (below) exits 0. *(post-deploy)*

### Smoke Verification (classifier side, exact spec command)

```bash
cd /Users/luke/apps/fcat-biochoco-camera-classifier
rm -rf data/v2 && tar -xzf /path/to/training-export-v2.tar.gz -C data/
uv run python - <<'PY'
from pathlib import Path
from data import load_manifest, verify_export_on_disk
m = load_manifest(Path('data/v2/manifest.json'))
verify_export_on_disk(m, m.split_root)
print(f"OK {len(m.class_list)} classes "
      f"(train={sum(m.counts_per_class[s]['train'] for s in m.class_list)}, "
      f"val={sum(m.counts_per_class[s]['val'] for s in m.class_list)}, "
      f"test={sum(m.counts_per_class[s]['test'] for s in m.class_list)})")
PY
```

Must print `OK …` and exit 0.

## Success Metrics

- The classifier's `load_manifest` accepts the next export without modification.
- The export admin UI shows the three livestock species in the dropped list with both their example count and "1 instalación" or "2 instalaciones" — making the data-curation followup self-explanatory.
- No "X especies sin cobertura completa en val/test" amber warning panel showing in the preview (it's been removed; the dropped-list now covers that case).

## Dependencies & Risks

- **No external dependencies.** Pure TypeScript change.
- **No schema migration.** Manifest shape unchanged; `cameraTrapTrainingDatasets` columns unchanged.
- **Content hash invalidation.** The next export will not match v1's hash (`classList` and rows shrink). This is correct — v2 is a smaller, valid export.
- **Edge case: pre-existing anchoring.** If a deployment was anchored under v2 with the bug present, dropping a class doesn't affect persisted splits for unrelated deployments. The deployment-split assignments are camera-stable and orthogonal to which classes survive inclusion.
- **One subtle behavior change.** Today, an admin lowering `minExamples` could rescue a small-deployment species (it would still ship with val=0). After the fix, lowering `minExamples` won't help these species — they need more *deployments*, not more examples. The enriched dropped-list copy makes this explicit so the admin doesn't waste time tuning the wrong knob.

## Files Touched

```
src/lib/training-export-helpers.ts              # new constant + extracted pure helper
src/app/camera-trap/training-exports/actions.ts # collectExportCandidates: two-condition pre-filter + post-stratify defensive drop; ExportPreview trimmed
src/app/camera-trap/training-exports/export-form.tsx  # remove stratifyWarnings panel; enrich dropped-species panel with deployment counts
tests/unit/training-export.test.ts              # 3 new tests covering both filters
```

## Deployment Steps

1. Merge the PR. Deploy with `./deploy.sh`.
2. (No `push-schema.mjs` run needed — no schema changes.)
3. Navigate to `/camera-trap/training-exports` as a super admin. Run an export with `minExamples = 30` (matching v1's threshold).
4. Download `data/training-exports/v<N>/` to the classifier machine; run the smoke verification block above.
5. Confirm `droppedSpecies` contains the three livestock species; confirm `classList` excludes them; confirm the classifier accepts the manifest.

## Out of Scope

- Changing `splitStrategyVersion` (stays at 2 — split-assignment algorithm itself is unchanged).
- Rebalancing class counts, oversampling, or class-weighted loss.
- Touching the classifier repo's `load_manifest` assertion (the assert is intentional).
- Verifying additional camera-trap detections for the dropped species — that's a data-curation followup, not a code change.

## References & Research

### Internal References

- Pre-filter location (current): `src/app/camera-trap/training-exports/actions.ts:209-225`
- Stratifier call site: `src/app/camera-trap/training-exports/actions.ts:280-310`
- Manifest emission: `src/app/camera-trap/training-exports/actions.ts:662-676`
- Stratifier algorithm: `src/lib/training-export-helpers.ts:91-229`
- `STRATIFY_MIN_DEPLOYMENTS = 3` (the constant reused as the inclusion threshold): `src/lib/training-export-helpers.ts:46`
- `SPLIT_STRATEGY_VERSION = 2` (deliberately unchanged): `src/lib/training-export-helpers.ts:23`
- Preview UI surfaces to update: `src/app/camera-trap/training-exports/export-form.tsx:258-271, 362-376`
- Existing unit tests (to extend): `tests/unit/training-export.test.ts`

### External References (consumer-side)

- Classifier assertion that triggered this work: `/Users/luke/apps/fcat-biochoco-camera-classifier/data.py:80-85`
- Classifier comment confirming unknown top-level keys are tolerated: `/Users/luke/apps/fcat-biochoco-camera-classifier/data.py:45`
- Broken v1 manifest: `/Users/luke/apps/fcat-biochoco-camera-classifier/data/v1/manifest.json`

### Related Prior Work

- Original exporter plan: `docs/plans/2026-04-08-feat-custom-species-classifier-training-plan.md`
- External classifier repo plan: `docs/plans/2026-04-08-external-training-repo-plan.md`
- `splitStrategyVersion: 2` introduction (the stratifier itself): `tests/unit/training-export.test.ts:138-167`
