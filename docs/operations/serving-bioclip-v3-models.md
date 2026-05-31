# Serving a BioCLIP (contract v3 / open_clip) classifier

The camera-trap classifier supports two reconstruction frameworks, selected by
`metrics.json.framework`:

| framework | contract | reconstruction | weights.pt size |
|-----------|----------|----------------|-----------------|
| `timm` (or absent) | v2 | `timm.create_model(...)` | ~200 MB (EfficientNetV2-M) |
| `open_clip` | v3 | `open_clip.create_model_and_transforms(...)` + linear head | **~2.5 GB** (BioCLIP ViT-H/14) |

A v3 model is registered exactly like a v2 one (scp into `data/models/<version>/`,
then Register in the UI). The portal verifies `weights.pt` against the
producer-emitted `metrics.weightsSha256` at registration, so a truncated scp is
caught immediately.

## Operational requirements specific to v3

1. **`open_clip_torch` in the ML venv.** Installed by `scripts/ensure-ml-venv.sh`
   and gated in its readiness import check. CPU-only torch on x86_64 (as in prod)
   runs a 632M ViT-H/14 forward per crop — heavy.

2. **Disk: budget ~5 GB transient on first reconstruction.** Building the arch
   downloads the ~2.5 GB hub checkpoint into the HF cache (its weights are
   discarded by the strict load), on top of the ~2.5 GB `weights.pt` on disk.
   `OpenClipClassifier.from_env` does a pre-flight free-disk check (~6 GB) and
   fails fast with a clear message rather than corrupting the cache mid-download.

3. **HF Hub reachability (or a pre-warmed cache).** First reconstruction resolves
   `hf-hub:imageomics/bioclip-2.5-vith14` from huggingface.co. Pre-warm the HF
   cache in the container build (alongside the existing TORCH_HOME warm-up) and
   verify it loads offline, or confirm prod egress to huggingface.co.

## ⛔ Before enabling a v3 model in prod — the cost gate

Accuracy is settled (BioCLIP beats EfficientNet decisively). **Cost is not.**
Profile on the actual prod box before flipping a v3 model live:

- peak RSS with the ViT-H **and** MegaDetectorV6 co-resident, against the
  container cgroup limit (target ≤ 80%);
- per-crop / per-image latency (P50/P95/P99) under sustained concurrency, against
  the operational SLO and expected crop volume;
- cold-start (load + first forward) vs the sidecar readiness/request timeouts.

See `docs/plans/...feat-portal-bioclip-v3-reconstruction-plan.md` (in the
classifier repo) for the full gate (Workstream E) and the staged-rollout /
rollback plan (active-model pointer, shadow mode) that should precede a global
flip.
