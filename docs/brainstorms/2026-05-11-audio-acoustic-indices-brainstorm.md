# Audio Acoustic Indices — Brainstorm

**Date**: 2026-05-11
**Status**: Brainstorm complete; ready for `/workflows:plan`

## What We're Building

A complementary analysis layer on top of the existing BirdNET pipeline that computes a small, well-validated set of **acoustic indices** on every audio file and exposes them as a descriptive, scientifically defensible way to compare habitat types and track soundscape change across FCAT sites.

This is **not** a replacement for BirdNET (which gives species-level detections). It is a parallel, lightweight signal that summarizes the *whole soundscape* — including non-vocalizing, cryptic, or undetected species — and that two recent regional studies (Müller et al. 2023, *Nat Commun*; Kümmet et al. 2025, *Conserv Lett*) have shown predicts vocalizing-vertebrate community composition with R² = 0.59–0.76 in the same lowland Chocó biome that FCAT works in.

Scope of the first build:

- Compute the **5 indices** validated by Müller 2023 / Kümmet 2025 on every audio file
- Stratify by **4 time-of-day windows** to respect diel community turnover
- Store per-file values; aggregate per (site × window × day) → per (site × window)
- Surface clear index-by-index comparisons across sites/habitat types in the UI
- Defer multivariate views (NMDS / ordination) and calibration to a future iteration

## Why This Approach

The two papers — both from <100 km away, same biome, same recorder type — converge on the same recipe. By matching their methods directly we get the strongest possible defensibility argument without doing our own ground-truth calibration: *"Our indices follow the directional patterns reported in Müller 2023 and Kümmet 2025 along the disturbance/recovery gradient in the lowland Chocó."* That claim is publishable and credible to funders.

Three principles drove the design:

1. **Don't invent science.** Use the exact 5-index set that has been validated regionally. Resist the temptation to add more indices or invent new combinations until the basic comparison is shown to work.
2. **Indices are descriptive, not absolute.** Raw index values mean little in isolation — what's defensible is the *pattern of differences* between sites. Surface the values, the expected direction (from the literature), and the sample coverage that produced them.
3. **YAGNI on the analytics.** NMDS, Hill-number standardization, frequency banding, and calibration models are all worthwhile — but only after we have indices flowing and have looked at the raw comparisons. Skip them for v1.

## Key Decisions

### Indices to compute (the 5 from Müller 2023 / Kümmet 2025)

| Index | What it captures | Expected direction toward old-growth (Chocó) |
|---|---|---|
| **Soundscape Saturation (SS)** | % of frequency bins occupied by sound above background. Burivalova 2018 definition. | ↑ (more diverse community fills more acoustic niches) |
| **Acoustic Complexity Index (ACI)** | Rapid amplitude changes within frequency bins over time. Pieretti 2011. | ↓ (soundscape becomes more constant/saturated; less contrast between calls and background) |
| **Frequency / Spectral Entropy (Hf / EVS)** | How evenly energy is distributed across frequency bins. | ↑ (energy spreads across more bands) |
| **Temporal Entropy (Ht)** | How evenly energy is distributed across time. | Weak/inconsistent signal in tropical forests — keep for completeness, expect noisy results |
| **Events per Second (EPS)** | Count of discrete acoustic events per unit time. Towsey 2018. | ↓ (saturation reduces discrete-event detection) |

These are **not** correlated enough to make any of them redundant (Müller 2023 confirmed weak pairwise correlation), so compute and report all five.

### Compute environment

- **Python via `scikit-maad`** inside the existing `data/ml-venv/`. Same infra as the BirdNET runner; supports per-file batch processing.
- ACI, Ht, Hf are available out of the box in `scikit-maad`.
- **Soundscape Saturation** and **Events per Second** are not packaged — port the algorithms from Burivalova 2018 and Towsey 2018 (each ~50 lines of NumPy). One-time effort; well-documented in the source papers.
- Audio is **resampled to 44.1 kHz** to match both papers' sample rate. Indices computed on **1-minute windows** (matches Kümmet 2025 and your recording cadence exactly).
- Frequency range for index computation: **50 Hz – 8 kHz** (Müller 2023 default), full bandwidth. No biophony/insect banding in v1.

### Temporal aggregation

- Recording schedule: 1 min every 5–10 min, 24h/day → 144–288 files/day per deployment.
- Compute indices on **every file**, store per-file rows.
- **Stratify into 4 time-of-day windows** (local Ecuador time, UTC-5):
  - **Dawn**: 05:00–07:00
  - **Midday**: 11:00–13:00
  - **Dusk**: 17:00–19:00
  - **Night**: 22:00–04:00
- Aggregate in two stages to avoid noisy-day bias:
  1. Per-file index → **median per (deployment × window × day)**
  2. Daily medians → **mean across days per (deployment × window)**
- Use **median** at the first stage (robust to rain/wind spikes), **mean** at the second stage (sample-size weighting).

### Coverage gating

Even for descriptive use, comparing sites with vastly different recording effort is the most common reviewer/funder objection. Hard rules:

- Require **≥7 days × ≥4 files per window per day** before reporting a site-window summary.
- Surface **coverage metadata** (n days, n files, % expected) on every chart and table — never let a number appear without its sample size.

### Comparison framework (v1)

- For each of the 5 indices, show **per-site × per-window** distributions (boxplots are ideal — median + IQR + outliers).
- Group sites by habitat type / recovery stage when that metadata exists in the DB.
- Include a **"published expectations" annotation** for each index — a small caption indicating the direction the literature predicts (e.g., "Müller 2023: SS rises toward old-growth"). The defensibility narrative is built into the UI.
- **Defer**: NMDS multivariate fingerprint, Hill-number standardization, linear models predicting BirdNET community axis, calibration against ground-truth.

### Storage

- New table: `audio_acoustic_indices` keyed on `audio_file_id`
- Columns: the 5 index values, computed timestamp, computation config hash (sample rate, window length, freq range, library version) — the hash gates re-computation when params change.
- One row per file. Aggregations done at query time or in views.

## Open Questions (for the plan phase)

1. **Where do indices fit in the existing ML job pipeline?** Should they run alongside BirdNET in the same job, or as a separate background job after BirdNET finishes? (Probably separate — indices are much cheaper to compute and don't block on BirdNET output.)
2. **Re-computation policy** — when the algorithm config hash changes (e.g., bug fix in our Soundscape Saturation port), do we re-run all historical files automatically, or surface a "stale" flag and require manual re-run?
3. **Habitat-type metadata** — do all deployments already have a habitat-stage tag (pasture / early-reg / late-reg / old-growth) that can drive groupings? If not, what's the labeling story?
4. **R-side export** — flat CSV export per (site × window × day × index) is probably enough for ecologists doing follow-up analyses in R (`seewave`, `vegan`, `iNEXT.beta3D`). Confirm format before building.
5. **"Published expectations" copy** — write the short Spanish-language captions that explain each index and its expected direction. These are user-facing strings (per CLAUDE.md: Spanish UI).
6. **What to call this in the UI** — "Índices Acústicos", "Análisis de paisaje sonoro" (soundscape analysis), or both?

## Future Iterations (explicitly out of scope for v1)

- **NMDS multivariate ordination** of sites using all 5 indices as the fingerprint. Single figure showing all sites at once along a gradient — strong for funder reports.
- **Calibration against BirdNET-derived community axis-1** — fit linear model (5 indices → BirdNET NMDS axis), report R² per FCAT, validate that the published methods transfer to your specific sites.
- **Frequency banding** — split ACI/SS/Hf into biophony band (2–8 kHz, birds) and insect band (8–22 kHz). Discriminates insect-rich vs bird-rich habitats.
- **Hill-number coverage standardization** (Chao & Jost 2012) — the rigor layer for cross-site comparisons when sample sizes are very unequal.
- **Adoption of Müller 2023 published coefficients** to score sites on a 0–1 recovery scale — needs validation but is a fast way to put a number on each site.

## References

- Müller, J. et al. (2023). *Soundscapes and deep learning enable tracking biodiversity recovery in tropical forests.* **Nat Commun** 14, 6191. [https://doi.org/10.1038/s41467-023-41693-w](https://doi.org/10.1038/s41467-023-41693-w)
- Kümmet, S. et al. (2025). *Acoustic Indices Predict Recovery of Tropical Bird Communities for Taxonomic and Functional Composition.* **Conserv Lett** 18, e13131. [https://doi.org/10.1111/conl.13131](https://doi.org/10.1111/conl.13131)
- Pieretti, N. et al. (2011). ACI definition. *Ecol Indic* 11, 868–873.
- Burivalova, Z. et al. (2018). Soundscape Saturation algorithm. *Conserv Biol* 32, 205–215.
- Towsey, M. (2018). Events per Second / Towsey amplitude spectrum. *Ecoacoustics Audio Analysis Software*.
- `scikit-maad` — [https://scikit-maad.github.io/](https://scikit-maad.github.io/)
