---
title: Chocó Species Classifier — External Training Repository
type: plan
date: 2026-04-08
intended_repo: train-choco-classifier (separate from fcat-portal)
---

# Chocó Species Classifier — External Training Repository

> This document is designed to be copy-pasted into a fresh repository as its
> `README.md` or `PLAN.md`. It is deliberately self-contained — it does not
> reference fcat-portal source files. The only fcat-portal artifacts it
> depends on are the `manifest.json` produced by the portal's dataset
> exporter and the `metrics.json` contract the portal expects back.

## Goal

Fine-tune a Chocó-specific species image classifier on verified camera-trap
detections exported from the FCAT portal, and produce artifacts that the
portal can load directly at inference time. Replace the stock
`AI4GAmazonRainforest` classifier (trained on Amazon species, a poor match
for Chocó biodiversity) with a model fine-tuned on local ground truth.

## Scope

**In scope**:
- A training pipeline that consumes a portal training-export directory and
  produces `weights.pt`, `metrics.json`, and `class_mapping.json` ready to
  SCP back to the portal.
- Metrics-only W&B logging (no dataset uploads).
- A standalone evaluation script for the held-out test split.
- A `package_model.py` script that assembles the portal contract.

**Explicitly out of scope**:
- Training on ephemeral/unverified labels. Only `verified` + `corrected`
  labels from the portal are training inputs.
- Automatic retraining pipelines / orchestration. This repo is run manually.
- Hyperparameter sweep frameworks. Pick sensible defaults; iterate by hand.
- Model distillation, quantization, or export to ONNX/TorchScript. The
  portal runs Python with `timm` + `torch`.
- Re-implementing train/val/test splitting. Splits are authoritative in the
  portal's export manifest — honor them byte-for-byte.

---

## Contracts with the FCAT Portal

The portal ↔ training-repo interface is intentionally narrow: two JSON
schemas and a fixed directory layout. Drift on either side will produce
silent accuracy regressions, so both contracts are validated at strict
boundaries.

### Input contract — what the portal produces

When an admin clicks **Exportar** on `/camera-trap/training-exports`, the
portal writes:

```
data/training-exports/<version>/
├── manifest.json
├── train/
│   ├── <species_slug>/
│   │   ├── <detectionId>.jpg
│   │   └── …
│   └── …
├── val/
│   └── …
└── test/
    └── …
```

Version strings are monotonic: `v1`, `v2`, `v3`, …. Re-exports with
identical inputs produce zero new data (the portal short-circuits on
content hash).

**Rules the training repo must honor**:

1. **Splits are authoritative.** Do NOT re-split `train/val/test`. Image
   assignment is deterministic at the *deployment* level on the portal side
   (not at the image level) so that each camera location stays in the same
   split across versions. Re-splitting at the image level would introduce
   data leakage.
2. **`manifest.json.classList` is ground truth.** Use it as the ordered
   class list for the model head. Ignore any on-disk directories that are
   NOT in `classList` (they should not exist, but belt-and-suspenders).
3. **Species slugs are stable.** The filesystem directory names
   (`<species_slug>`) are lowercase ASCII-slug conversions of the species
   label. Do NOT derive class labels from the on-disk directory names;
   derive them from `classList` in the manifest.

**`manifest.json` schema** (copy this literally — it's the portal's slim
format; any new fields the portal adds will be additive):

```json
{
  "version": "v1",
  "contentHash": "sha256:<64 hex chars>",
  "createdAt": "2026-04-08T14:23:01Z",
  "createdBy": "admin@example.com",
  "splitStrategyVersion": 1,
  "minExamplesThreshold": 50,
  "classList": ["leopardus_pardalis", "puma_concolor", "..."],
  "droppedSpecies": { "puma_yagouaroundi": 12, "tapirus_bairdii": 7 },
  "counts": {
    "total": 12450,
    "train": 8730,
    "val": 1870,
    "test": 1850,
    "perClass": {
      "leopardus_pardalis": { "train": 1840, "val": 395, "test": 388 }
    }
  },
  "deployments": [
    { "id": 42, "split": "train", "imageCount": 234 }
  ],
  "warnings": []
}
```

Note: `classList` entries are already in slug form. The training repo uses
them directly as the model's class labels.

### Output contract — what the training repo must produce

After a training run completes, produce this directory:

```
<model_version>/
├── weights.pt
├── metrics.json
└── class_mapping.json
```

**`weights.pt`**: a **bare PyTorch state_dict** saved with `torch.save`.
NOT a Lightning checkpoint. NOT a dict wrapping `{state_dict: ...,
optimizer: ...}`. The portal loads it with:

```python
state = torch.load(weights_path, map_location="cpu")
model.load_state_dict(state, strict=True)
```

`strict=True` will hard-fail on any key mismatch, which is intentional —
silent architecture drift is worse than a loud failure at registration
time. The `package_model.py` script must therefore:
- Strip any auxiliary training heads (distillation tokens, aux outputs, etc.)
- Ensure the number of classes in the final `nn.Linear` matches
  `len(classListOrdered)` exactly

**`class_mapping.json`**: a JSON array of class labels, in the order the
model's final linear layer expects. Rule:

```
class_mapping.json[i] === metrics.classListOrdered[i]   ∀ i
```

The portal validates this byte-for-byte at registration time. Any mismatch
is a hard fail — as designed, because class-index drift is the most
dangerous silent failure mode in classification ("ocelot detected" but
actually returning jaguar's index).

**`metrics.json` schema** (copy literally — the portal validates every
field listed and rejects missing ones):

```json
{
  "modelVersion": "v1",
  "trainingDatasetVersion": "v3",
  "trainingDatasetContentHash": "sha256:<hash from manifest>",
  "backbone": "efficientnet_b0",
  "transform": {
    "imageSize": 224,
    "mean": [0.485, 0.456, 0.406],
    "std": [0.229, 0.224, 0.225]
  },
  "recommendedConfidenceThreshold": 0.55,
  "overall": {
    "top1Accuracy": 0.873,
    "macroF1": 0.812
  },
  "perClass": {
    "leopardus_pardalis": {
      "precision": 0.91,
      "recall": 0.88,
      "f1": 0.895,
      "support": 388
    }
  },
  "classListOrdered": ["leopardus_pardalis", "puma_concolor"]
}
```

**Field semantics**:
- `modelVersion`: user-supplied, monotonic (`v1`, `v2`, …). Must be unique
  across all models registered on the portal.
- `trainingDatasetVersion`, `trainingDatasetContentHash`: copied verbatim
  from the manifest. The portal uses the hash to verify provenance; a
  mismatch fails registration unless an admin checks "allow untracked".
- `backbone`: any `timm` model name (e.g. `efficientnet_b0`,
  `resnet50`, `vit_small_patch16_224`). The portal's inference side passes
  this to `timm.create_model(backbone, pretrained=False,
  num_classes=len(class_list))`, so it must match what was trained.
- `transform.imageSize`, `transform.mean`, `transform.std`: the EXACT
  normalization values used at training time. The portal applies the same
  transform at inference time. **Do not** rely on
  `timm.data.resolve_model_data_config()` defaults at inference — the
  portal reads these from `metrics.json` explicitly so any non-default augs
  are honored.
- `recommendedConfidenceThreshold`: initial guess for the
  display-time threshold. Starts at `0.55` by default. The portal admin
  can retune this via SQL at any time (it's a tunable display-layer knob,
  not a training hyperparameter). Aim for the value that gives best
  precision@recall=0.9 on the validation split, or start loose and tighten
  after observing real-world behavior.
- `overall.top1Accuracy`, `overall.macroF1`: computed on the **test**
  split, not val. This is the honest generalization metric.
- `perClass[slug]`: per-class precision/recall/F1/support on the **test**
  split. `support` is the number of test examples for that class.
- `classListOrdered`: the class label order that matches the model's
  final linear layer. MUST equal `class_mapping.json` byte-for-byte.

---

## Recommended Repository Layout

```
train-choco-classifier/
├── README.md                (this document, possibly trimmed)
├── pyproject.toml            (or requirements.txt)
├── .gitignore                (gitignore runs/, .venv/, __pycache__)
├── scripts/
│   ├── train.py              (main entry: trains one model, saves checkpoint)
│   ├── evaluate.py           (re-evaluate an existing checkpoint on the test split)
│   └── package_model.py      (write weights.pt + metrics.json + class_mapping.json)
├── src/train_choco/
│   ├── __init__.py
│   ├── data.py               (manifest loader, ImageFolder wrapper, transforms)
│   ├── model.py              (timm.create_model wrapper with a verifier)
│   ├── training_loop.py      (optimizer, scheduler, train/val loops, early stop)
│   ├── metrics.py            (top-1, per-class P/R/F1, macro F1)
│   └── config.py             (TrainConfig dataclass, CLI argparse)
└── runs/                     (gitignored — local W&B logs, checkpoints, packaged models)
```

Keep it small. This repo runs by hand a few times per year; the footprint
of a Lightning / Hydra / W&B-Launch setup is not justified.

---

## Dependencies

Minimal and boring — pin to versions you can reinstall in a year:

```toml
# pyproject.toml (or equivalent)
[project]
name = "train-choco-classifier"
requires-python = ">=3.10"
dependencies = [
  "torch>=2.2,<3",
  "torchvision>=0.17,<1",
  "timm>=1.0,<2",
  "Pillow>=10,<12",
  "numpy>=1.26,<3",
  "scikit-learn>=1.4,<2",
  "pyyaml>=6,<7",
  "tqdm>=4.66,<5",
  "wandb>=0.16,<1",       # optional — see below
]
```

- **`torch` / `torchvision`**: install the appropriate CUDA or CPU wheel
  for your hardware. On a Mac with M-series silicon, use the default
  PyPI wheels (MPS-capable). On a CUDA GPU, use the CUDA 12.1 index.
- **`timm`**: provides backbones and pretrained weights.
- **`wandb`**: optional — set `WANDB_MODE=disabled` to skip logging. When
  enabled, log metrics only — do NOT upload datasets or images. The portal
  brainstorm explicitly chose metrics-only logging for privacy and
  reproducibility reasons.

---

## Training Script Walkthrough

### CLI shape

```bash
python scripts/train.py \
  --manifest /path/to/v3/manifest.json \
  --backbone efficientnet_b0 \
  --epochs 30 \
  --lr 3e-4 \
  --batch-size 64 \
  --weight-decay 1e-4 \
  --warmup-epochs 2 \
  --patience 5 \
  --out runs/2026-04-08_v1
```

### Step-by-step

1. **Load the manifest.** Parse `manifest.json`, extract `classList` and
   `counts.perClass`. Verify the on-disk tree (`<manifest_dir>/train`,
   `val`, `test`) exists. Warn on any on-disk class directory NOT in
   `classList` — do not include it in training.

2. **Build datasets.** For each of `train`, `val`, `test`, construct a
   `torchvision.datasets.ImageFolder` rooted at
   `<manifest_dir>/<split>/`. **Override `class_to_idx`** to match
   `manifest.classList` order, so:
   - `class_to_idx[manifest.classList[i]] == i`
   - The output `classListOrdered` will then be literally
     `manifest.classList`.

   This is critical. `ImageFolder`'s default behavior is to sort directory
   names alphabetically, which is *usually* the same as `sorted(classList)`
   but not guaranteed for all slugs. Overriding the map removes any
   possibility of drift.

3. **Define transforms.** Record the exact values you use in a dict that
   will be copied into `metrics.json.transform`:

   ```python
   IMAGE_SIZE = 224
   MEAN = [0.485, 0.456, 0.406]
   STD = [0.229, 0.224, 0.225]

   train_tf = transforms.Compose([
     transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
     transforms.RandomHorizontalFlip(),
     transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.2),
     transforms.RandomErasing(p=0.25),
     transforms.ToTensor(),
     transforms.Normalize(mean=MEAN, std=STD),
   ])
   eval_tf = transforms.Compose([
     transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
     transforms.ToTensor(),
     transforms.Normalize(mean=MEAN, std=STD),
   ])
   ```

   If you change these, also change `metrics.json.transform`. The portal
   reads these at inference time and will be wrong if they diverge.

4. **Build the model.**
   ```python
   model = timm.create_model(
     backbone, pretrained=True, num_classes=len(class_list),
   )
   ```
   Sanity-check: `model.num_classes == len(class_list)` and
   `model.get_classifier().out_features == len(class_list)`.

5. **Loss + class weighting.** Use weighted cross-entropy to handle the
   heavy Chocó class imbalance without throwing data away:
   ```python
   counts = np.array([counts_per_class[slug] for slug in class_list])
   class_weights = 1.0 / np.sqrt(counts)
   class_weights = class_weights * len(counts) / class_weights.sum()
   loss_fn = nn.CrossEntropyLoss(
     weight=torch.tensor(class_weights, dtype=torch.float32),
   )
   ```
   `1/sqrt(count)` damps the dominant classes without collapsing rare ones
   to a single example's worth of gradient. Avoid hard oversampling — it
   inflates effective dataset size and hurts calibration.

6. **Optimizer + scheduler.**
   ```python
   optimizer = torch.optim.AdamW(
     model.parameters(), lr=args.lr, weight_decay=args.weight_decay,
   )
   scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
     optimizer, T_max=args.epochs - args.warmup_epochs,
   )
   # Linear warmup for the first `warmup_epochs` epochs, then cosine decay.
   ```

7. **Train loop.** Standard:
   - For each epoch: train on `train`, evaluate on `val`.
   - Log every epoch: `train_loss`, `val_loss`, `val_top1`, `val_macro_f1`,
     per-class val metrics.
   - Early stopping: patience=5 on `val_macro_f1`. Save the best checkpoint.
   - Optional W&B logging: `wandb.log({...})`, no images/artifacts.

8. **Final evaluation.** Load the best checkpoint. Evaluate on the
   **test** split (not val). Compute:
   - `top1Accuracy` (overall)
   - `macroF1` (unweighted mean of per-class F1s)
   - Per-class precision/recall/F1/support (`sklearn.metrics.precision_recall_fscore_support`)

9. **Write artifacts.** Save:
   - The best checkpoint (as a training-native file, e.g. `best.ckpt`,
     for re-evaluation later)
   - A plain-text summary of metrics for quick review

10. **Call `package_model.py`** (can be chained at the end of `train.py`
    or run as a separate step).

### `package_model.py`

Takes a checkpoint + a manifest + a user-supplied `--model-version` and
writes the three portal-contract files:

```bash
python scripts/package_model.py \
  --checkpoint runs/2026-04-08_v1/best.ckpt \
  --manifest /path/to/v3/manifest.json \
  --backbone efficientnet_b0 \
  --model-version v1 \
  --recommended-threshold 0.55 \
  --out runs/2026-04-08_v1/packaged/
```

Steps:

1. Load the checkpoint, rebuild the model with the right backbone and
   `num_classes=len(manifest.classList)`.
2. Sanity-check: `model.get_classifier().out_features == len(manifest.classList)`.
3. Strip any auxiliary heads (e.g. teacher/student distillation tokens).
4. Save `weights.pt = model.state_dict()` — bare state_dict, no nesting.
   ```python
   torch.save(model.state_dict(), out_dir / "weights.pt")
   ```
5. Write `class_mapping.json = manifest.classList` — JSON array, matches
   the model's class order exactly.
6. Re-run evaluation on the test split (or load cached metrics from the
   training run) and assemble `metrics.json` per the contract above.
7. Round floats to 4 decimals for readability. Pretty-print with
   `json.dumps(..., indent=2)`.
8. Print a one-line summary: `packaged v1 (efficientnet_b0, 8 classes, top1=0.873, macroF1=0.812)`.

---

## Deployment Workflow

Once you have a packaged model directory:

```bash
# On the portal droplet, create the destination directory
ssh droplet 'mkdir -p /root/opt/fcat-portal/data/models/v1'

# Copy the three contract files (and nothing else)
scp runs/2026-04-08_v1/packaged/{weights.pt,metrics.json,class_mapping.json} \
    droplet:/root/opt/fcat-portal/data/models/v1/
```

Then on the portal UI, as a super admin:

1. Navigate to **Cámaras Trampa → Modelos**.
2. Under **Directorios sin registrar**, find the new `v1` entry with
   three green badges (weights.pt, metrics.json, class_mapping.json).
3. Click **Registrar**. The portal validates the contract:
   - All required fields present
   - `class_mapping.json == metrics.classListOrdered` byte-for-byte
   - `metrics.modelVersion` is unique
   - `weights.pt` exists and is non-empty
   - `metrics.trainingDatasetContentHash` matches a registered dataset
     (check the "Permitir dataset no registrado" checkbox if you trained
     against an ad-hoc export, but avoid this in production)
4. If validation fails, read the Spanish error message — it's specific
   (e.g. "class mismatch at index 3: ..."). Fix and re-register.
5. Once registered, the row appears as **Inactivo**.
6. Click **Activar**. The portal refuses if an ML job is currently running;
   wait for it to complete. On success, the portal shuts down the running
   Python model server so the next inference job re-spawns with the new
   weights.
7. Smoke-test by running inference on a small deployment and checking the
   results page. Sub-threshold predictions will render as "Sin identificar"
   per the display-layer confidence threshold.

---

## Retraining Cadence

Retrain when any of these is true:

- **New collaborator data batch verified** (adds meaningful class coverage)
- **> 6 months** since the last training run
- **Per-species recall drops below target** in production (observed via
  verification UI: lots of corrections for a particular class)

Always:

1. Run a fresh portal export first (`Cámaras Trampa → Exportes → Exportar`).
   Don't train on a stale snapshot. The portal short-circuits if nothing
   changed, so re-exporting costs nothing if there's no new data.
2. Use the **latest export's `manifest.json`** as the training input.
3. Bump `modelVersion` to the next monotonic value (`v2`, `v3`, …).
4. Keep the previous model registered but inactive for rollback. The
   portal allows you to re-activate any registered model.

---

## Things to Watch For (Gotchas)

### Class imbalance
Chocó species distributions are extremely skewed — a few species dominate,
many have tens of examples. Use **weighted cross-entropy** (described
above). Do NOT use hard oversampling or undersampling: the former hurts
calibration, the latter throws away signal.

### Data leakage via image-level splitting
**Do not** re-split at the image level. Portal splits are deterministic at
the deployment level so that the same camera location stays in the same
split across versions. Image-level splitting would let the model memorize
specific backgrounds and inflate metrics by 10–20 percentage points.

### Confidence calibration
Raw softmax probabilities are systematically overconfident on rare
classes. The portal's display-layer threshold (`recommendedConfidenceThreshold`)
is how we deal with this: set it, observe production behavior, tune via
SQL update on `camera_trap_models.confidence_threshold`, no reprocess
required. Start loose (`0.5`) and tighten if FPs are a problem.

### Transform drift
Whatever normalization you use at training time MUST be copied verbatim
into `metrics.json.transform`. The portal reads `imageSize`, `mean`, and
`std` from the JSON at inference time — it does NOT fall back to
`timm.data.resolve_model_data_config()` defaults. Drift here produces
silent accuracy regression (the model sees differently-normalized tensors
and its predictions skew).

### Strict state_dict loading
The portal loads weights with `strict=True`. If your training pipeline
adds any auxiliary heads (distillation tokens, teacher outputs, SSL
projectors), `package_model.py` MUST strip them before saving
`weights.pt`. A failed `load_state_dict` at registration time means you
can't register the model at all.

### `ImageFolder` alphabetical sorting
`torchvision.datasets.ImageFolder` sorts class directory names
alphabetically by default. This is *usually* the same as `sorted(classList)`,
but for non-ASCII or mixed-case slugs it can diverge. **Always override
`class_to_idx`** to match `manifest.classList` order explicitly. Then the
model's class indices match the portal's expectations by construction.

### Backbone pretrained weights download
The first time you train, `timm` downloads pretrained weights from
Hugging Face. On spotty internet, this fails halfway and leaves partial
files in `~/.cache/huggingface`. If you get weird "unexpected EOF" errors,
clear that cache and retry.

---

## Minimum Viable First Run

To get a first registered model on the portal as quickly as possible:

```bash
# 1. Fresh export on portal
#    (Cámaras Trampa → Exportes → set min=20 to include rare species → Exportar)

# 2. rsync the export dir locally
rsync -av droplet:/root/opt/fcat-portal/data/training-exports/v1/ ./data/v1/

# 3. Train with defaults
python scripts/train.py \
  --manifest ./data/v1/manifest.json \
  --backbone efficientnet_b0 \
  --epochs 20 \
  --lr 3e-4 \
  --batch-size 64 \
  --out runs/first/

# 4. Package
python scripts/package_model.py \
  --checkpoint runs/first/best.ckpt \
  --manifest ./data/v1/manifest.json \
  --backbone efficientnet_b0 \
  --model-version v1 \
  --recommended-threshold 0.55 \
  --out runs/first/packaged/

# 5. Ship it
scp runs/first/packaged/{weights.pt,metrics.json,class_mapping.json} \
    droplet:/root/opt/fcat-portal/data/models/v1/

# 6. Register + activate via the portal UI
```

The first run is a baseline. Iterate on hyperparameters (backbone size,
LR, augmentation strength) by comparing `val_macro_f1` across runs. Don't
chase every decimal — the model gets retrained regularly as more verified
data comes in, so a decent first baseline is worth more than a
locally-optimal first attempt.

---

## Handoff

When this plan is executed:

1. Create an empty repo (GitHub or local), e.g. `train-choco-classifier`.
2. Copy this document in as `README.md` (optionally trim sections that
   aren't relevant to your workflow, but keep the Contracts section
   verbatim).
3. Initialize the Python project structure (pyproject.toml, venv).
4. Implement the scripts and src modules per the walkthrough above.
5. Test end-to-end with a portal export of at least ~500 detections.
6. Register the first model against the portal.

The portal will tell you loudly if anything is wrong with the packaged
output. Lean on its validation — don't try to debug silent drift by
reading the model's predictions.
