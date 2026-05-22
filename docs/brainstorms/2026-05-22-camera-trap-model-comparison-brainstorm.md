---
date: 2026-05-22
topic: camera-trap-model-comparison
---

# Camera Trap Model Comparison & Per-Species Metrics

## What We're Building

A unified comparison view on the existing `/camera-trap/models` admin page that surfaces per-species and overall performance across all registered classifier models. Admins should be able to (1) pick the right model before activating, (2) audit per-species strengths/weaknesses, and (3) track improvement across model versions — all in one place.

The training pipeline at `/Users/luke/apps/fcat-biochoco-camera-classifier` already produces most of the data we need (overall accuracy, macro F1, per-class precision/recall/F1/support, training hyperparameters, confusion matrix as a CSV sidecar). The gap is on the portal side: `metricsJson` is stored as an opaque blob and only top-1 accuracy is surfaced. Confusion matrix CSV is not imported at all.

This brainstorm covers both the portal UI and the small contract additions needed from the training repo.

## Why This Approach

Considered three options:

- **A (Minimal):** Parse existing JSON server-side, add confusion matrix as JSON. Quickest, but no SQL sortability for per-species columns.
- **B (Normalized per-class metrics) — chosen.** New `camera_trap_model_class_metrics` table; confusion matrix + hyperparameters stay as JSON blobs. Enables sortable per-species columns and trend queries across versions; small migration cost.
- **C (Full normalization):** Also normalize confusion matrix + hyperparams. Overkill — confusion matrices are read whole, key/value hyperparams in SQL are awkward.

Approach B matches all three stated use cases and the answer to "all registered models at once with drill-down."

## Key Decisions

- **Location:** Expand the existing `/camera-trap/models` page rather than build a separate compare sub-page. Admins already go there to register/activate; comparison is the natural extension.
- **Comparison scope:** Show all registered models at once (one row per model), with sortable per-species columns and a drill-down detail panel/row per model. No 2-model "diff view" — the table itself is the comparison.
- **Schema (Approach B):**
  - New table `camera_trap_model_class_metrics(modelId, className, precision, recall, f1, support, trainCount)` — one row per (model, class).
  - New column on `cameraTrapModels`: `confusionMatrixJson` (parsed from `confusion_matrix.csv` at import time, nested JSON keyed by true→predicted).
  - New column on `cameraTrapModels`: `trainingConfigJson` (or surface from existing `metricsJson.training`) — hyperparameters (optimizer, lr, batch size, epochs, loss, scheduler, git SHA).
  - Per-class **train count** added alongside the existing **support** (test count) so admins can see "this class is weak because it only has 30 training images."
- **Training repo contract (no backward compat — bump contract version):**
  - `metrics.json` must include `perClass[class].trainCount` (in addition to existing `support` which is the test count).
  - `confusion_matrix.csv` becomes a required output file (currently sidecar).
  - `metrics.json.training` already has hyperparameters; we just need to import them.
  - Import logic rejects models that don't satisfy the new contract version.
- **Confusion matrix viz:** Render as a heatmap in the drill-down view (one model at a time). Not in the main table.
- **No sample misclassified images** in v1 — defer; requires training-repo changes + storage we haven't scoped.

## Open Questions

- **Class set alignment across models:** When comparing models trained on different class sets (e.g., v3 added "ocelot"), how do we render the per-species columns? Two options: (a) union of all classes, with N/A for missing entries, or (b) intersection, with a note about what's hidden. Probably (a) with subtle indicator.
- **Activation gating:** Should we add a "promote to active" affordance from the comparison table directly, or keep activation in its current row-action place? (Lean: keep separate — activation has safety checks for in-flight jobs.)
- **Trend visualization:** Is a small sparkline per class across model versions worth it in v1, or defer? (Lean: defer; table sort is enough until there are 5+ models.)
- **Confusion matrix scale:** With ~20+ classes the heatmap gets dense. Do we offer "top-N confused pairs" view as a complement? (Probably yes — cheap to add.)
- **Backfill of existing models:** Since contract is bumped without backward compat, existing registered models would lack the new fields. Confirm: are we OK marking those as "legacy — re-export to compare" or do we need a one-time backfill script?

## Next Steps

→ `/workflows:plan` for implementation details (schema migration, import-time parsing of CSV, UI components for sortable per-class columns + heatmap drill-down, training-repo contract bump).
