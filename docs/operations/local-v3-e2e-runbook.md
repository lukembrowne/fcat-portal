# Local end-to-end test: serve a BioCLIP (v3) model through the portal

Goal: register a real BioCLIP model in the portal running locally, activate it,
run a real camera-trap job, and confirm species predictions come out. This is
the full-stack pass the standalone reconstruction test (which already proved
strict-load + bit-identical predictions) doesn't cover: registration → DB →
model-server spawn → job pipeline → results UI.

Prereq already done: `scripts/stage_v3_test_model.py` staged the last4 model at
`data/models/v4-bioclip-vith14-last4/` (v3 + weightsSha256 + frameworkVersion).

---

## A. Start the portal in dev

```bash
cd /Users/luke/apps/fcat-portal
docker compose up -d --build       # --build picks up the HF_HOME entrypoint + ensure-ml-venv change
docker compose logs -f portal      # watch; Ctrl-C when you see "ML venv ready" / next dev listening
```
Dev portal: **http://localhost:3003** (no auth proxy in dev; you're `lukebrowne@fcat-ecuador.org`).

## B. Make sure open_clip is in the ML venv

The venv is a persistent volume built before open_clip was added, so install it
once (fast path — no full rebuild):

```bash
docker compose exec portal uv pip install --python data/ml-venv/bin/python3 "open_clip_torch>=2.24,<3"
docker compose exec portal data/ml-venv/bin/python3 -c "import open_clip; print('open_clip', open_clip.__version__)"
```
(Alternative: `docker compose down && docker volume rm fcat-portal_ml-venv && docker compose up -d --build` to rebuild the venv from scratch — slower, but `ensure-ml-venv.sh` now installs open_clip on its own.)

## C. Register the model

1. Open **http://localhost:3003/camera-trap/models**.
2. `v4-bioclip-vith14-last4` shows up as an **unregistered** dir → click **Register**.
3. Expect success. This silently exercises the new path: v3 schema acceptance,
   the version↔framework biconditional, and the **streamed weights-hash
   verification** against `metrics.weightsSha256`.
   - If it errors with `weights_hash_mismatch` → the weights file changed; re-stage.
   - If `schema_violation` on `framework`/`contract.version` → wrong artifact.

## D. Activate it

In the models comparison table, click **Activate** on `v4-bioclip-vith14-last4`.
It becomes the classifier the pipeline uses.

## E. Run a job on a few real images

Grab a handful of labeled test images to upload:
```bash
mkdir -p /tmp/bioclip-test && \
cp /Users/luke/apps/fcat-biochoco-camera-classifier/data/2026-05-29-v4/val/Leopardus\ pardalis/*.jpg \
   /Users/luke/apps/fcat-biochoco-camera-classifier/data/2026-05-29-v4/val/Eira\ barbara/*.jpg \
   /tmp/bioclip-test/ 2>/dev/null; ls /tmp/bioclip-test | head
```
Upload a few of these through the camera-trap processing UI and run detection +
classification. **First classify downloads BioCLIP (~2.5 GB) into the container's
HF cache** (`/app/data/ml-cache/huggingface`, now persistent) — one-time, ~30 s.

While it runs, watch the model server:
```bash
docker compose logs -f portal | grep -iE "custom_openclip|Loaded|classifier|error"
```
You want to see: `Loaded custom_openclip (hf-hub:imageomics/bioclip-2.5-vith14, 25 classes) on cpu`.

## F. Check predictions

In the results UI, detected animals should carry species labels + confidences
(e.g. `Leopardus pardalis 0.93`). Sanity-check they're reasonable — the
standalone test got ~72% top-1 on a 40-image sample, so most should be right,
with plausible look-alike misses.

---

## Pass criteria
- [ ] Registration succeeds (no `schema_violation` / `weights_hash_mismatch`).
- [ ] Logs show `Loaded custom_openclip (... 25 classes)`.
- [ ] Job completes; detections carry real species predictions + confidences.
- [ ] Predictions look sane on images you know.

## If it breaks
| Symptom | Likely cause |
|---------|-------------|
| `custom_openclip load failed: No module named 'open_clip'` | Step B not done / venv didn't pick it up |
| Hang then fail on first classify | HF download blocked — check container egress to huggingface.co |
| `insufficient free disk` | < 6 GB free on the data volume for the HF cache |
| Registration `weights_hash_mismatch` | weights.pt differs from the staged hash — re-run the staging script |

## Cleanup
```bash
# Deactivate by activating the previous (EfficientNet) model in the UI, then:
rm -rf data/models/v4-bioclip-vith14-last4    # removes the hardlink, not the source run
```
