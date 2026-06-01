# BioCLIP cost-gate decision sheet (Phase 2 / Workstream E)

**Purpose:** decide whether to serve a BioCLIP (v3) classifier in prod. Accuracy
is settled; this is the *can the server handle it?* gate. Fill this in by running
the profiler **on the actual prod droplet** (or an identical instance). Do not
serve a v3 model to users until this says **GO**.

---

## Step 0 — Write the budgets BEFORE measuring

(So the gate isn't fitted to whatever the profile happens to produce.)

| Budget | Value | Where it comes from |
|--------|-------|---------------------|
| Memory headroom | `0.8` (peak RSS must stay ≤ 80% of the container limit) | OOM-killer safety margin |
| Latency SLO (P95 per crop) | `______ ms` | your tolerance per photo / crop volume |
| Throughput target | `______ crops/s` | must exceed peak ingest rate, or define a backlog tolerance |
| Crops per image (avg) | `______` | from real camera-trap data (often 1–2) |
| Expected peak burst | `______ images at once` | worst case: a camera dump |

## Step 1 — Run the profiler on the droplet (INSIDE the container)

The ML venv lives **inside the container**, so run the profiler there with the
same interpreter the model-server uses — that's what makes the numbers faithful
(same CPU allocation, env, and torch build). Do NOT run it on the host.

```bash
# Faithful: exec into the running portal container, use the venv python.
docker compose exec portal data/ml-venv/bin/python3 \
    scripts/profile-bioclip-cost.py \
    --ram-limit-gb <host RAM in GB> \
    --ram-headroom 0.8 \
    --latency-slo-ms <your SLO> \
    --target-imgs-per-s <your target> \
    --crops-per-image <your avg>

# Or an isolated one-off (not competing with the live Node process for RAM):
#   docker compose run --rm portal data/ml-venv/bin/python3 scripts/profile-bioclip-cost.py ...
```

**Prerequisites (this deployment specifically):**
- **`--ram-limit-gb` is required.** The container has no `mem_limit` set, so the
  script can't auto-detect a ceiling. OOM risk is governed by **host RAM, shared
  with the Node server** — budget against host RAM, and either run when the
  portal is idle or watch `docker stats` for the combined total.
- **Rebuild the image / venv first.** Containers built before open_clip was added
  to `ensure-ml-venv.sh` won't have it; the readiness check reinstalls on next
  boot, or `uv pip install open_clip_torch` into the live venv.
- **First run downloads ~2.5 GB** into `HF_HOME=/app/data/ml-cache/huggingface`
  (now persistent — see docker-entrypoint.sh). Needs ~5 GB free on the data
  volume + HF egress, once.

It loads MegaDetector **and** BioCLIP together (true co-residency), then prints
machine spec, cold-start, P50/P95/P99 latency, peak RSS, and a GO/NO-GO verdict.

> Run it a few times, and ideally while a real-ish workload is going, so peak RSS
> reflects concurrent forwards (MegaDetector + BioCLIP overlapping), not a single
> idle measurement.

## Step 2 — Record the measured numbers

| Metric | Measured | Budget | Pass? |
|--------|----------|--------|-------|
| Droplet: vCPU / RAM / cgroup limit | `___ / ___ GB / ___ GB` | — | — |
| Peak RSS (both models) | `___ GB` | ≤ 0.8 × limit = `___ GB` | ☐ |
| P95 latency per crop | `___ ms` | ≤ `___ ms` | ☐ |
| P99 latency per crop | `___ ms` | (watch the tail) | ☐ |
| Throughput | `___ crops/s` | ≥ `___ crops/s` | ☐ |
| Cold start (load + first forward) | `___ s` | < sidecar/request timeout | ☐ |
| Est. P95 per image | `___ ms` | within SLO | ☐ |

Baseline for sanity (committed Mac CPU floor, an *optimistic* lower bound — a
shared-vCPU droplet is usually slower per core):
**BioCLIP ViT-H ≈ 417 ms/crop, 3.0 crops/s, 2.5 GB** vs EfficientNet ≈ 210 ms, 5.8 crops/s, 0.2 GB.

## Step 3 — Decide

- **All three pass (RSS + latency + throughput) → GO.** Proceed to the safe
  rollout (active-model pointer → shadow mode → single-project pilot; see the
  Phase 2 plan, Workstream H). Don't flip it global on day one.
- **RAM is the only blocker → bf16 plan.** Half-precision weights ~halve the
  footprint (2.5 → ~1.25 GB) but need a new `precision` contract field and a
  model built in bf16 before load. Open that as a separate plan, then re-run this.
- **Latency / throughput is the blocker → re-scope.** Options: a GPU box (much
  faster for a ViT-H), run classification offline in batches instead of live, or
  keep it shadow-only. Don't force-ship a too-slow model.
- **Both marginal → NO-GO.** That's a no, not a coin flip.

## Step 4 — Also do the one-time real-ViT-H round-trip

Separately from cost: produce a real BioCLIP artifact, register it, and confirm
the portal reconstructs it (`strict` load, no missing keys) and its predictions
match the trainer. CI only exercises the tiny offline arch — this is the only
check of the *real* 2.5 GB reconstruction. Do it once on this same box.

---

**Verdict:** ☐ GO   ☐ NO-GO   ☐ bf16 first   ☐ re-scope
**Date / who ran it:** ______________________
**Notes:** ______________________
