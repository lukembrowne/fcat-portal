# BirdNET Confidence Threshold Filtering

**Date:** 2026-05-13
**Status:** Brainstorm complete — ready for `/workflows:plan`
**Context:** Triggered by Tebbutt et al. paper on BirdNET performance in the Colombian Amazon, which provides species-specific 95% confidence thresholds for ~90 forest-specialist species.

---

## What We're Building

A **user-configurable global confidence threshold** for BirdNET detections, applied at read time across all analytics, list, and export surfaces. Users land on a justified, conservative default (0.7) and can adjust per-view via a slider. The raw data store is left untouched — all detections ≥ 0.1 (BirdNET's floor) continue to be ingested.

**Out of scope (deliberately deferred):** species-specific thresholds, per-recorder thresholds, recorder-type tracking, regional threshold variation. These are real and well-evidenced (the paper makes the case), but a single global threshold is the simpler shipping target and unblocks the immediate problem (current UI presents 0.1+ noise as if it were signal).

---

## Why This Approach

The paper makes one finding unmissable: **BirdNET's raw confidence score is not a probability.** The 95% threshold ranges from 0.10 (White-throated Toucan, easy for BirdNET) to 0.99 (Purple-throated Fruitcrow, almost never trustable) for the same model output. Today the portal stores and displays everything ≥ 0.1 with no filtering — meaning users currently draw ecological conclusions from a mix of real detections and noise, weighted heavily by which species BirdNET happens to mis-fire on.

A **single global threshold** doesn't fix that fully (the right number is different per species), but it cuts the obvious noise and gives users a tunable knob to explore precision/recall tradeoffs. It also requires zero schema changes and zero re-ingestion: filter at the query layer.

**Default of 0.7** is defensible:
- Above the median 95%-threshold of the paper's species (~0.6 across both recorders).
- Aligns with Wood & Kahl (2024) guidelines for general use.
- Conservative enough that the loudest false-positive species (Spix's Guan @ 0.96, Fruitcrow @ 0.99) still get filtered down hard, while reliable species (toucans, macaws, woodpeckers) survive easily.

---

## Key Decisions

### Threshold Model
- **One global threshold**, not species-specific. Per-species is in the Follow-ups section.

### Default Value
- **0.7**, with a one-line "why this default" tooltip citing Wood & Kahl (2024) and the Tebbutt et al. range.

### Where the User Configures It
- **Per-view slider**, value persisted in `localStorage` and reflected in the URL so views are shareable.
- No DB column, no admin-managed app-wide setting. Each user explores their own tolerance.

### Where the Filter Applies (all read-time, query-layer)
| Surface | Behavior |
|---|---|
| Summary statistics (species counts, detections-per-day, charts) | Respects threshold. |
| Deployment audio overview | Respects threshold. |
| Detection tables in annotation page | Respects threshold by default + **"Show all detections" toggle** to reveal everything ≥ 0.1 for borderline validation. |
| Data exports (CSV) | Respects active threshold; export filename or header notes the threshold used (for reproducibility). |
| Ingestion / storage | **Unchanged.** All detections ≥ 0.1 stored. Threshold is never destructive. |

### Interaction with Verification State
The threshold is only one of two filters. Human verification overrides it:

| Detection status | Behavior |
|---|---|
| Manually **rejected** (false positive) | Always hidden, regardless of threshold. |
| Manually **verified** (true positive) | Always shown, regardless of threshold. |
| **Unverified** | Visible only if `confidence >= threshold`. |

Rationale: a human who's looked at the spectrogram outranks BirdNET's raw score in either direction.

---

## Implementation Sketch (For Planning Phase)

These are pointers, not the plan itself.

- **Query helper:** central function `applyConfidenceFilter(qb, threshold)` that emits the WHERE clause: `(verification_status = 'verified' OR (verification_status != 'rejected' AND confidence >= ?))`. Reused across every aggregation site.
- **Threshold state:** small React hook `useConfidenceThreshold()` reading from URL param `?conf=0.7`, falling back to localStorage, falling back to 0.7. Returns `[value, setValue]`.
- **Server actions:** every action that reads detections accepts an optional `threshold: number` arg (defaulted to 0.7) and threads it into queries. Server-side default centralised in a constant (`DEFAULT_CONFIDENCE_THRESHOLD = 0.7`) so the planning doc can reference it.
- **UI component:** a shared `<ConfidenceThresholdSlider>` (range 0.1–1.0, step 0.05, default 0.7) placed in the filter bar of each affected view. Includes tooltip with citation.
- **Annotation page:** slider + "Show all detections" toggle (when toggled on, sets threshold to 0.1 for that page only).
- **Exports:** filename includes threshold (`detections_conf-0.70_2026-05-13.csv`) and CSV gets a header comment.

---

## Open Questions

1. **Live count preview on the slider.** Should moving the slider show "N detections / N species" updating live? Adds polish but a real query cost — defer to planning.
2. **Acoustic indices vs detection threshold.** Acoustic indices (ACI, BI, etc.) are computed independently of detections — does the threshold affect any derived index display? (Believed not, but flag for plan to confirm.)
3. **Existing summary panels.** Need a pass during planning to enumerate every spot that currently aggregates `audio_identifications` — there are at least the deployment overview, the indices page, the annotation page header, and BirdNET job-completion stats.
4. **Cite the threshold in UI copy.** Where exactly does the user see "current threshold: 0.7"? In the page header? Sidebar? Below charts? Plan should standardise.
5. **CSV export format.** Bare CSV, or also a methods sidecar (`README.txt` describing the threshold and citing the paper)?

---

## Explicit Follow-ups (Future Brainstorms)

These were considered and deliberately deferred. Each warrants its own brainstorm later:

- **F1: Per-species thresholds seeded from Tebbutt et al.** Add `min_confidence` column to `species` table, import the paper's tables as a CSV seed, switch the WHERE clause to `confidence >= COALESCE(species.min_confidence, global_default)`. Same UX (one slider, one global default), much sharper science. Highest-value follow-up.
- **F2: Track recorder type per deployment.** Required before F1 can use the per-recorder thresholds the paper provides (AudioMoth vs Swift values differ). Add `recorder_type` to deployments.
- **F3: Per-region thresholds.** Paper's Figure 4 shows thresholds shift between Caquetá-Guaviare and Putumayo. Lower priority; only matters once we have multi-region deployments and per-species thresholds.
- **F4: Custom classifier integration.** Paper provides a custom-trained classifier for an additional 14 species (incl. IUCN Vulnerable Common Woolly Monkey). Separate pipeline question — should the portal optionally run the custom classifier alongside BirdNET 2.4 and merge results?
- **F5: Confidence threshold preview / explainer.** A small page explaining what the threshold means, with an interactive demo showing how N detections change as you slide. Good for onboarding ecologists who haven't read Wood & Kahl.

---

## Success Criteria

- Default landing view on every audio analytics surface shows only detections ≥ 0.7 (or human-verified).
- User can drag a slider, see counts update, and share the view via URL.
- An ecologist preparing a report can cite "filtered at confidence ≥ 0.7 (Wood & Kahl, 2024)" and that statement matches what their exports contain.
- No data loss: dropping the threshold to 0.1 reveals exactly what's in the DB today.
- Manually rejected detections never reappear; manually verified ones never disappear.
