---
date: 2026-04-08
topic: custom-species-classifier-training
---

# Custom Chocó Species Classifier — Training Infrastructure

## What We're Building

Infrastructure to fine-tune a Chocó-specific species classifier on human-verified camera trap images, replacing `AI4GAmazonRainforest` at the classification stage of the existing MegaDetector → classifier pipeline. MegaDetector stays as the detector; only the classifier is swapped.

The loop: **portal exports verified crops → external repo trains a timm model on Mac (or GPU droplet) → portal registers the resulting weights and swaps them into the inference runner**. Designed to be re-run iteratively as more data arrives from BioChoco monitoring and collaborators.

## Why This Approach

Considered three levels of portal involvement: (1) data-export-only, (2) data + model registry, (3) full in-portal training UI. Chose a **hybrid of (1) and (2)**: portal owns dataset export *and* a lightweight model registry, but training itself lives in a separate repo.

Reasoning:
- Portal's ML docker install is already painful (see `docs/solutions/build-errors/pytorchwildlife-docker-install-failures.md`). Adding training-time deps (CUDA, MPS, large datasets, checkpoints) for a workflow that runs monthly — not hourly — would be a bad trade.
- Training needs hardware flexibility (Mac MPS vs CUDA droplet) that doesn't belong in a Next.js container.
- But the portal *must* know which model is live and how it compares to prior versions, especially for the eventual public release. A thin registry (table + upload UI + "set active" button) gives us that with zero GPU deps.
- External training repo can pin torch/torchvision/timm/CUDA versions independently, forever.

For the training framework, chose **plain PyTorch + timm** over PytorchWildlife, Ultralytics YOLO, or HF Transformers. Reasons: no install pain, works identically on Mac MPS and CUDA droplets, standard `.pt` output loadable with ~20 lines of inference code, and `timm` is the standard in the camera trap ML literature.

## Key Decisions

- **Training lives outside the portal.** New repo (or folder in BioChoco) consumes the portal's exported dataset. Portal never installs training-time dependencies.
- **Portal owns the data export + the model registry + the inference swap.** Three concrete pieces, all in scope for v1.
- **Splits are deployment-level and locked at first assignment.** All images from a single deployment (camera-location-session) go to the same train/val/test bucket forever. Prevents burst-sequence leakage and matches the camera trap ML standard. New deployments get hashed deterministically into a split when they're first exported.
- **Export format: pre-cropped MegaDetector boxes + manifest.json.** One image per verified animal detection, cropped from the MD box, organized as `<split>/<species>/<uuid>.jpg`. `manifest.json` records dataset version, per-image metadata (deployment, timestamp, verifier, source image ID), split assignments, and class distribution. This mirrors what the classifier sees at inference time and is ready for `torchvision.datasets.ImageFolder`.
- **Framework: plain PyTorch + timm.** Start with a small backbone (EfficientNet-B0 or ConvNeXt-Tiny). ~300 lines of training loop in the external repo.
- **Eval lives in the external training repo**, not the portal. **Tool: Weights & Biases, metrics-only mode** (no raw images or location metadata uploaded — camera trap data is sensitive). W&B free OSS tier handles metrics, confusion matrices, per-class precision/recall, and cross-run comparison. Public W&B project doubles as a free training-progress dashboard for the eventual public release. Training run emits a `metrics.json` that the portal registry ingests when the model is uploaded.
- **Model handoff: admin upload UI → `data/models/<version>/`.** New `cameraTrapModels` table tracks version, metrics JSON, class-mapping JSON, dataset version hash, and `active` flag. "Set active" button tells the ML runner which weights to load. Simple, auditable, no cloud dependency.
- **Inference swap:** Python ML runner loads the custom timm model directly (`torch.load` + forward pass) for the classification stage. MegaDetector detection path is untouched. AI4GAmazonRainforest remains available as a fallback option in `ML_DEFAULTS` for backwards comparison.
- **Minimum examples per species: 50 verified examples** to be trained as a class. Rare species below threshold are **dropped from training, not merged into "unknown"** (merging teaches the model to confidently mislabel). Portal `biochoco_species` table defines the *universe* of possible classes; the exporter computes the *actual* class list from verified data at/above threshold. New species auto-join training the moment they cross 50 verified examples — no manual config. Manifest records dropped species with their current counts (e.g. "Puma concolor: 48 examples — needs 2 more").
- **Handling dropped rare species at inference time: confidence-thresholded "Sin identificar" surface label.** MegaDetector still draws the bounding box for any animal (detection is class-agnostic), but if the custom classifier's top-1 probability is below a per-model calibrated threshold, the portal surfaces the detection as `"Sin identificar — baja confianza"` and flows it into the existing human verification queue. Verified rare species accumulate and auto-join future training runs — this turns the weakness into the retraining loop's engine.
- **Confidence threshold is calibrated per-model on the validation set** and stored in `cameraTrapModels` alongside the weights. Training repo emits a recommended threshold in `metrics.json`; the admin upload UI stores it; the ML runner reads it when loading the model.

## In Scope for v1

1. **Portal: dataset export + splits + manifest** — new export action that produces a versioned `dataset-vN.tar.gz` (or directory) with crops, manifest, and a deterministic split assignment per deployment.
2. **External training repo** — plain PyTorch + timm training script that consumes the export, runs on Mac MPS and on a Linux GPU, and emits `weights.pt` + `metrics.json` + `class_mapping.json` + `confusion_matrix.png` + a pointer to the dataset version it trained on.
3. **Portal: model registry + upload UI + inference swap** — `cameraTrapModels` table, admin page to register a model version, "Set active" button, and ML runner updated to load the custom classifier when one is marked active.
4. **External eval system** — Weights & Biases (metrics-only), reporting confusion matrix, per-species precision/recall, and top-1 / top-5 accuracy. No images or location metadata uploaded to W&B.

## Out of Scope for v1 (Deferred)

- **In-portal eval dashboard** (confusion matrix UI, accuracy-over-time charts). Registry will store the metrics JSON so this can be added later without schema changes.
- **Collaborator data import workflow** (accepting external verified datasets, label normalization, deduplication). Powerful but not needed until the first self-contained training loop is proven.
- **Automated retraining triggers.** Retraining stays manual for now.
- **Training on the DigitalOcean droplet.** Droplet has no GPU; any GPU droplet work is deferred until Mac MPS training is validated.
- **Multi-model A/B inference.** One active model at a time.
- **Retraining the detector.** MegaDetector stays frozen.

## Dataset Versioning + Split Locking

**Split locking: write-once column on deployments.**

- New column `training_split` on `biochoco_deployments` (nullable, enum `train`/`val`/`test`).
- First time a deployment participates in an export, the exporter assigns it deterministically via `hash(deploymentId) % 100` (< 70 = train, < 85 = val, else = test — 70/15/15 ratio). Persisted and never overwritten.
- **Manual override** available to admins (gated, audit-logged, rare) in case a specific deployment needs to move splits. Overrides are recorded in the manifest so reproducibility is preserved.
- **Label corrections do NOT change splits.** Splits are about data provenance (which deployment went where); labels are about training signal. The two are deliberately decoupled.

**Dataset versioning: new `camera_trap_training_datasets` table + semver.**

Schema sketch:
```ts
camera_trap_training_datasets = {
  id, version (semver string), contentHash (SHA-256),
  createdAt, createdBy,
  imageCount, classCount,
  minExamplesThreshold,
  classListJson, droppedSpeciesJson,
  manifestLocation
}
```

**Content hash inputs** (deterministic, excludes noise):
1. Sorted list of `(imageId, finalLabel, deploymentId, trainingSplit)` tuples
2. `minExamplesThreshold`
3. Sorted class list

Excluded: timestamps, verifier identity, file paths, machine info, model versions. Two exports with identical inputs produce identical hashes — and if a new export's hash matches an existing row, no new version is created (print "dataset identical to vX, no export needed").

**Semver bump rules (computed automatically by the exporter):**

- **MAJOR** (`1.0.0` → `2.0.0`): trained class list changes (species crossed/fell below the 50-example threshold, or `minExamplesThreshold` itself changed). MAJOR because model weights from one major version can't architecturally load into another — output neurons differ.
- **MINOR** (`1.0.0` → `1.1.0`): new verified images or new deployments added, class list unchanged.
- **PATCH** (`1.0.0` → `1.0.1`): label corrections only — same deployments, same images, same class list, some labels updated by humans.

If multiple change types happen between exports, **highest wins** (MAJOR > MINOR > PATCH). Exporter supports a `--force-major` override for manual re-curation that should be marked as a new generation.

**Models are FK-linked to their training dataset.** `camera_trap_models.trainingDatasetId` → `camera_trap_training_datasets.id`. Lets the portal answer "which data did this model train on?" and "what classes did it know?" from the database alone. The training repo reads `manifest.json` (which carries `version` + `contentHash`), logs both to W&B, and the admin upload UI verifies the manifest hash matches a known dataset row before registering the model.

## Schema Changes (Summary)

1. **New column**: `biochoco_deployments.training_split` (nullable, write-once, enum).
2. **New table**: `camera_trap_training_datasets` (see above).
3. **New table**: `camera_trap_models` (version, weightsPath, classMappingJson, metricsJson, confidenceThreshold, `trainingDatasetId` FK, `active` boolean, createdAt, createdBy).

## Open Questions (For Planning Phase)

- **Weight storage location.** `data/models/` is fine for one droplet, but if weights get large (100MB+ each) and accumulate, consider offloading older versions to R2/Drive and keeping only the active + last-1 locally.
- **Public release packaging.** Eventually we want to publish the model. Does it go on Hugging Face Hub? GitHub releases? This shapes the metadata the registry should record (license, citation, model card template). Deferred until after the first self-contained training loop is working.

## Next Steps

→ `/workflows:plan` for implementation details (schema, file layout, training script skeleton, inference swap)
