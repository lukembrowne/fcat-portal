---
title: Camera Trap ML Pipeline CPU Tuning
type: perf
date: 2026-04-07
---

# Camera Trap ML Pipeline CPU Tuning

Speed up the camera-trap ML workflow on the existing 4-vCPU DigitalOcean droplet (no infra changes). Expected combined win: 2–4× throughput on typical jobs. Best realistic case: a 30 min job runs in 8–12 min; worst case: ~25% faster from steps 1+2 alone.

## Files touched

- `scripts/model-server.py` — primary
- `scripts/predict.py` — delete (dead code on live path)
- `src/lib/ml-runner.ts` — env vars on spawn, cancel-handling audit
- `src/lib/ml-defaults.ts` — `numWorkers: 2 → 4`

## Background

The camera-trap ML pipeline runs PyTorch-Wildlife (MegaDetector V6 + AI4G Amazon Rainforest classifier) on CPU inside the `fcat-portal-portal-1` Docker container, sharing a 4-vCPU droplet with ~25 other containers. There is no GPU. The persistent worker is `scripts/model-server.py`, spawned and managed by `src/lib/ml-runner.ts`.

Investigation found three issues, in order of impact:

1. **No real batched inference.** `model-server.py:215-292` loops `detector.single_image_detection(...)` per image. PyTorch-Wildlife internally hard-sets `predictor.args.batch = 1` on that path. The `batch_size` config knob currently only controls how many images are pre-loaded together; it does NOT batch the model forward pass.
2. **Pre-loaded image arrays are silently discarded by detection.** `process_image` at `scripts/model-server.py:134` calls `detector.single_image_detection(image_path)` — passing a path string. The library re-opens the file from disk. The threadpool pre-loading work at `scripts/model-server.py:226-232` is wasted for the dominant cost; only the classifier crop on line 172 actually consumes `img_array`.
3. **No PyTorch thread tuning on a noisy shared host.** PyTorch defaults to physical core count (4), and OpenMP/MKL each have independent pools that can oversubscribe. No `torch.set_num_threads` or `OMP_NUM_THREADS` is set anywhere. Host swap is already at 87% used — the box is stressed.

## Prerequisite — verify the PyTorch-Wildlife API in the actual installed venv

**Do NOT skip this step.** The plan depends on PW API signatures that vary across versions. The local `data/ml-venv/` is populated only inside the container, so verify there:

```bash
docker compose exec portal /app/data/ml-venv/bin/python -c "
from PytorchWildlife.models.detection.ultralytics_based import yolov8_base
import inspect
print(inspect.getsource(yolov8_base.YOLOV8Base.single_image_detection))
print('---')
print(inspect.getsource(yolov8_base.YOLOV8Base.batch_image_detection))
"
```

Confirm:

- [x] `single_image_detection` accepts an `np.ndarray` as the first positional arg (not just a path string). Verified 2026-04-07: signature is `single_image_detection(self, img, img_path=None, det_conf_thres=0.2, id_strip=None)`.
- [x] There is a kwarg to pass the original path through (commonly `img_path=...`, but some PW versions use `img_size` here — verify before writing the call). Verified: kwarg is `img_path=`.
- [x] `batch_image_detection` exists, accepts `data_source: list[np.ndarray]`, has a `batch_size` and `det_conf_thres` kwarg, and returns a list of result dicts aligned to input order. Verified: `batch_image_detection(self, data_source, batch_size: int = 16, det_conf_thres: float = 0.2, id_strip: str = None)`.
- [x] Each result dict has the same shape as `single_image_detection`'s return (a `detections` field with `xyxy`, `class_id`, `confidence` arrays). Verified: both call the same `results_generation` helper. Note: batch path uses `f"{start_idx + idx}"` as `img_id` — must override with our own path tracking (already in PR2 plan).

If any of these don't match, stop and revise the plan. Don't write code against an unverified API.

---

## PR 1 — Thread tuning + pre-load fix + numWorkers bump (steps 1, 2 + default tweak)

Small, low-risk, mergeable in one pass. Restart `fcat-portal-portal-1` after merging — the persistent model-server process needs to reload to pick up new env vars and code.

### Step 1.a — Spawn-side env vars (the load-bearing change)

OpenMP/MKL/OpenBLAS read these at native lib load time, *before* Python's `os.environ.setdefault` has a chance to run. The Node-side env vars are the real change; the Python-side ones (1.b) are defense-in-depth.

**File:** `src/lib/ml-runner.ts`

In `spawnModelServer()` at `src/lib/ml-runner.ts:322-333`, extend the spawn `env` block:

```ts
env: {
  ...process.env,
  HOME: "/tmp/ml-home",
  MPLCONFIGDIR: "/tmp/matplotlib-config",
  YOLO_CONFIG_DIR: "/tmp/Ultralytics",
  DETECTOR_MODEL: ML_DEFAULTS.detectorModel,
  CLASSIFIER_MODEL: ML_DEFAULTS.classifierModel,
  // Cap native thread pools — see docs/plans/2026-04-07-perf-camera-trap-ml-cpu-tuning-plan.md
  OMP_NUM_THREADS: "2",
  MKL_NUM_THREADS: "2",
  OPENBLAS_NUM_THREADS: "2",
  NUMEXPR_NUM_THREADS: "2",
},
```

**Why 2, not 4:** the host shares 4 vCPUs across ~25 containers. The downside of starving the API container during a 30-min ML job is worse than the ML job taking 35 min instead of 30. Start at 2; bump to 4 only after observing that neighbors are unaffected during a real job. CLAUDE.md notes the swap is at 87% — don't punch the box.

### Step 1.b — Python-side thread caps (defense-in-depth)

**File:** `scripts/model-server.py`

At module top (above the function defs, around line 30, before any future test harness might import this as a module):

```python
import os
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "2")
```

Inside `load_models` at `scripts/model-server.py:55`, immediately after `import torch`:

```python
torch.set_num_threads(2)
torch.set_num_interop_threads(1)
```

**Note:** `set_num_interop_threads` must be called before any parallel work starts in PyTorch — call it once, at startup, never again. `load_models` is the right place.

### Step 2 — Pre-load fix

**File:** `scripts/model-server.py:134`

Change:

```python
det_result = detector.single_image_detection(image_path)
```

to (assuming the API check confirmed `img_path=` kwarg):

```python
det_result = detector.single_image_detection(img_array, img_path=image_path)
```

This makes `single_image_detection` use the already-loaded numpy array instead of re-opening the file. Keep the rest of `process_image` (lines 125-187) untouched — `img_array` is still needed for the classifier crop on line 172.

### Step 1+2 default change

**Deferred 2026-04-07.** Original plan was to bump `numWorkers: 2 → 4`. Skipping for now because the production droplet (8 GB RAM, 4 GB swap saturated) just OOM-killed the container at the existing settings. With 4 preload workers × 16 batch, peak in-flight decoded arrays would be ~64 — too aggressive on this box. Revisit after PR2's true batching lands and we have peak-RSS numbers.

`src/lib/ml-defaults.ts` stays at `numWorkers: 2`, `batchSize: 16` for PR1.

### PR 1 acceptance criteria

- [ ] PW API verification (prerequisite) completed and confirms expected signatures.
- [ ] Restart `fcat-portal-portal-1`, run a small job (~20 images).
- [ ] `Using device: cpu` line still appears in logs.
- [ ] Run completes successfully, output schema unchanged (spot-check 3 images: same number of detections, same bbox coords within rounding).
- [ ] Compare img/s vs. pre-change baseline — expect 1.1–1.5× cumulative.
- [ ] During the job, check `docker stats` and a few neighbor containers for response-time degradation. If they're starved, drop the thread vars to 1; if they're fine after a couple of full jobs, optionally bump to 4.

---

## PR 2 — True batched inference + predict.py cleanup (steps 3 + 4)

**ABANDONED 2026-04-07.** Microbenchmark on Apple Silicon CPU (Docker, aarch64, 3 threads, MDV6-yolov9-c, 16 × 1280×1280 images) showed batched inference is *slower* than per-image, not faster:

```
single_image_detection ×16:        38.3s   (2.40s/img)
batch_image_detection(bs=16):      46.1s   (2.88s/img)   ← 20% SLOWER
batch_image_detection(bs=1):       38.4s   (2.40s/img)
```

Ultralytics' speed report on the bs=16 run confirmed the inference DID happen as one batched forward pass at shape `(16, 3, 1280, 1280)` — so batching is real, it just doesn't help on CPU. Per-image time inside the batched call: ~2875 ms vs ~2400 ms in the per-image path.

**Why the plan was wrong:** batching speedups come from amortizing GPU kernel launch overhead and exploiting massively parallel cores. On CPU, inference is bound by memory bandwidth and sequential matmul; one large activation tensor actually hurts cache behavior and incurs more page faults, hence the slowdown. The "2-4× win" prediction was best-practice GPU advice misapplied to CPU.

**What we kept from PR 2:**
- Step 4 (delete `scripts/predict.py`) — landed, dead code regardless.
- The `detections_from_result` helper extracted from `process_image` — cleaner code, neutral perf.
- The cancel-handler audit (concluded the handler is fine) — useful future reference.

**What we abandoned:**
- The `process_job` rewrite to use `batch_image_detection`. Reverted to per-image with the PR1 preload fix kept.
- The "infer-fallback" diagnostic logging.

**Remaining real perf wins available on CPU:**
- More cores (linear with thread count, until memory bandwidth saturates around 4-8 threads on this hardware).
- Smaller / quantized model (out of scope for this plan).
- GPU (out of scope for this plan).

The original PR 2 spec follows for historical context — DO NOT IMPLEMENT.

---

### Step 3 — `process_job` batched inference

**File:** `scripts/model-server.py`, function `process_job` (lines 190-332)

Replace the per-image inference loop with `detector.batch_image_detection`. Inner-loop sketch for each batch:

1. Pre-load with the existing threadpool (already correct — `scripts/model-server.py:226-232`).
2. Partition loaded items into `valid` (no error, has array) and `failed` (PIL load error). Emit `error` events for failed ones now.
3. Wrap in try/except. Inside try, call:
   ```python
   det_results = detector.batch_image_detection(
       [item["array"] for item in valid],
       batch_size=len(valid),
       det_conf_thres=confidence_threshold,
   )
   ```
   `batch_size=len(valid)` so the library does ONE forward pass per pre-loaded chunk — the outer loop already controls chunking, no double-batching.
4. Walk `det_results` parallel to `valid`. For each, build the `detections_list` exactly as `process_image` does today (filter by confidence, normalize bbox using `item["width"] / item["height"]`, run classifier crop on animals at class_id 0).
5. Emit `progress` + `result` events per image as you walk results, so the UI still gets per-image updates (just bursting at the end of each batch).
6. Cancel check between batches (keep the existing one). The per-image cancel check inside the result-walk is now near-instant (no inference happening) — keep it for responsive cancel during the classifier crops, but **see correctness note 5 below**.

### Critical correctness requirements

1. **Per-image error isolation.** `batch_image_detection` is all-or-nothing — if it raises, you lose the whole batch. On exception, fall back to per-image `single_image_detection(img_array, img_path=...)` for just that batch so one bad image doesn't kill 16 others. Log a warning with the batch number.

2. **Result alignment.** `batch_image_detection` returns results in input order. The library's internal `img_id` field is a stringified index — ignore it and use `valid[i]["path"]` for the emitted `image` field.

3. **Bbox normalization.** Do NOT use the library's `normalized_coords` field. Keep the existing manual normalization using `item["width"] / item["height"]` so the output schema stays byte-identical to today's. Verify via the schema diff below.

4. **Classifier path unchanged.** Classifier still runs per-detection on cropped arrays. Animals are a small fraction of detections and the crop is cheap. Don't try to batch the classifier in this PR.

5. **Cancel mid-result-walk leaves partial batches.** Today, each image's `progress` + `result` are emitted atomically inside `process_image`. With batching, the model has already inferenced all N images in a batch before you start emitting any results — so a cancel at result-walk-step-3-of-16 means 13 images were inferenced but never emitted to the consumer. **Audit `src/lib/ml-runner.ts`'s cancel handler** to confirm it tolerates `processed < N inferenced`. If it assumes `processed == results_emitted`, this needs a fix before merging. If unsure, the safer option is to drop the per-image cancel check entirely and only cancel between batches — the user waits at most ~2-5s longer for cancel response, which is acceptable.

6. **Progress cadence shifts from per-image to per-batch.** With `batch_size=16` this is ~0.5–2s gaps in progress events. Document in the commit message so frontend folks know.

### Step 3 default tuning

Keep `batchSize: 16` initially. After step 3 lands, `batch_size` finally controls the model forward pass. Sweet spot for MDv6-yolov9-c on a 4-vCPU CPU box is usually 8–16. Benchmark before changing the default.

### Step 4 — Delete `scripts/predict.py`

I confirmed `predict.py` is dead code on the live path. References:

- `scripts/README.md:99` — doc only
- `docs/plans/2026-02-14-feat-camera-trap-video-processing-plan.md:362` — historical plan note
- `docs/plans/2026-02-11-feat-google-drive-camera-trap-workflow-plan.md:238,307` — historical plan notes
- **No callers in `src/`** — `ml-runner.ts:309` uses `model-server.py`

Action:

- [ ] `git rm scripts/predict.py`
- [ ] Update `scripts/README.md` to remove the predict.py section.
- [ ] No code changes elsewhere — there are no callers.

### Benchmarking — REQUIRED before merging PR 2

Run the same 100–200 image folder (representative camera-trap batch with a mix of empty and animal images) three times per config. Take median img/s from the per-batch summary log line in `process_job` (`scripts/model-server.py:301-311`).

| Config | batch_size | num_workers | threads | Notes |
|---|---|---|---|---|
| Baseline (pre-PR1) | 16 | 2 | unset (4) | `git stash` and run on main |
| After PR1 | 16 | 4 | 2 | Threading + pre-load fix |
| PR2, threads=2 isolated | 16 | 4 | 2 | Isolates batching from threads |
| PR2, threads=4 | 16 | 4 | 4 | Isolates threading aggression |
| PR2, smaller batch | 8 | 4 | 2 | |
| PR2, larger batch | 32 | 4 | 2 | |

Record peak RSS of the python process during each run (`docker stats fcat-portal-portal-1` or `ps -o rss= -p <pid>`). If batch=32 pushes the container above ~2GB, back off — host swap is already saturated.

### Output schema verification

Run baseline and post-PR2 against the same 20-image folder, capture stdout NDJSON, diff the result lines:

```bash
jq -c 'select(.type == "result")' baseline.ndjson | sort > a.ndjson
jq -c 'select(.type == "result")' new.ndjson      | sort > b.ndjson
diff a.ndjson b.ndjson
```

Filter out `info` events (timing varies run-to-run). The diff must be empty. Detection bboxes, confidences, classifications must be byte-identical (modulo the existing `round(..., 4)`).

### PR 2 acceptance criteria

- [ ] PW API verification re-confirmed for `batch_image_detection`.
- [ ] `ml-runner.ts` cancel handler audited for partial-batch tolerance (or per-image cancel check removed).
- [ ] Benchmark table filled in with real numbers, included in PR description.
- [ ] Schema diff is empty.
- [ ] At chosen default config: ≥1.5× img/s vs. baseline. If not, investigate before merging — likely culprit is the library still falling back to `batch=1`. Check `predictor.args.batch` after the call.
- [ ] Per-image error isolation verified by manually corrupting one image in a 20-image folder and confirming the other 19 still process successfully.
- [ ] `scripts/predict.py` deleted, `scripts/README.md` updated.
- [ ] Tested on a real production-sized job in dev before merging.

---

## Rollout strategy

**Two PRs, no bake delay:**

1. **PR 1** = steps 1 + 2 + numWorkers default. Restart container after merge.
2. **PR 2** = step 3 + step 4 (predict.py deletion).

Why not 3 PRs with a 24-hour bake between them: this is a one-person internal portal with low traffic, and the value of `git bisect`-ability comes from having distinct PRs, not from time between them. The "bake for a day" advice is multi-engineer-team CYA that doesn't apply here. Run the benchmark + schema diff (~1 hour total), then ship.

**Exception:** if a researcher is currently waiting on a critical job for an external deadline, ship PR 1 first, let their job finish on the safe code, then ship PR 2.

---

## What this plan deliberately does NOT do

- No GPU, no model swap, no quantization, no ONNX export.
- No changes to `requirePermission()` / job creation / DB schema. Pure inference path.
- No new dependencies — uses APIs already present in the installed PyTorch-Wildlife.
- No frontend changes. Progress event cadence shifts slightly (per-batch vs per-image) but the event shape is unchanged.
- No tuning of the classifier — it's per-detection on small crops, not the bottleneck.
- No bumping `torch.set_num_threads` to 4 by default. Knob is documented; bump after observing neighbor impact during a real job.

---

## Expected outcome

| Step | Expected speedup (cumulative) | Risk |
|---|---|---|
| 1 (threads, capped at 2) | 1.0–1.1× | very low |
| 2 (pre-load fix) | 1.1–1.3× | very low |
| 3 (batched inference) | 2.0–4.0× | medium — needs benchmark + schema diff |
| 4 (predict.py cleanup) | 0× (dead code) | very low |

Best realistic case: 30-min job → 8–12 min after PR 2. Worst case (real batching gives only marginal improvement on this YOLO variant): still ~25% faster from PR 1 alone.

---

## References

### Verified file locations

- Current per-image inference loop: `scripts/model-server.py:215-292`
- The pre-load bug: `scripts/model-server.py:134`
- Wasted threadpool pre-loading: `scripts/model-server.py:226-232`
- Classifier crop (the only consumer of `img_array` today): `scripts/model-server.py:172`
- `load_models` (where `torch.set_num_threads` goes): `scripts/model-server.py:53-98`
- Spawn env block (where Node-side env vars go): `src/lib/ml-runner.ts:322-333`
- Defaults: `src/lib/ml-defaults.ts:5-11`
- Dead code (delete in PR 2): `scripts/predict.py`

### Related docs

- `CLAUDE.md` — ML pipeline conventions, host constraints (4 vCPUs, swap at 87%)
- `scripts/README.md:99` — needs predict.py section removed in PR 2
