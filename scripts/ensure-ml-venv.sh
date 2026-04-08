#!/bin/sh
set -e

ML_VENV_DIR="${ML_VENV_DIR:-data/ml-venv}"
ML_PYTHON="$ML_VENV_DIR/bin/python3"

# Docker: nextjs user home is /nonexistent, needs writable dirs
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
export UV_LINK_MODE=copy
export MPLCONFIGDIR="${MPLCONFIGDIR:-/tmp/matplotlib-config}"

# Pre-warm torch hub model weights into TORCH_HOME (set in docker-entrypoint.sh
# to /app/data/ml-cache/torch — persistent across container restarts).
# Idempotent: if weights are already on disk, this is a fast no-op import.
# Without this, the first ML job after a restart pays a ~3 min download cost
# (MegaDetector V6 ~200 MB + AI4GAmazonRainforest ~188 MB).
# `|| true` because warm-up failure should NEVER block the venv setup —
# the worst case is the first job pays the download cost like before.
warm_model_cache() {
  if [ -n "$TORCH_HOME" ]; then
    mkdir -p "$TORCH_HOME"
    echo "[ml-setup] TORCH_HOME=$TORCH_HOME (persistent: should survive restarts)"
  else
    echo "[ml-setup] WARNING: TORCH_HOME not set — weights will land in ephemeral \$HOME/.cache/torch and re-download next boot. Check docker-entrypoint.sh."
  fi
  echo "[ml-setup] Pre-warming model weights — this prints granular progress so you can see where time goes"
  # PYTHONUNBUFFERED=1 so prints land in docker logs immediately, not buffered.
  # 2>&1 merges stderr (where tqdm writes its progress bars) into stdout so the
  # download progress bars are visible in `docker compose logs`.
  PYTHONUNBUFFERED=1 "$ML_PYTHON" - 2>&1 <<'PYWARM' || echo "[ml-setup] Pre-warm failed/skipped — first job will pay download cost"
import os, sys, time

os.environ.setdefault("OMP_NUM_THREADS", "3")
os.environ.setdefault("MKL_NUM_THREADS", "3")

def log(msg):
    print(f"[ml-warmup] {msg}", flush=True)

log(f"TORCH_HOME={os.environ.get('TORCH_HOME', '<unset>')}")
log(f"HOME={os.environ.get('HOME', '<unset>')}")

import torch
log(f"torch {torch.__version__} loaded, hub dir = {torch.hub.get_dir()}")

t0 = time.monotonic()
log("Importing PytorchWildlife.models.detection...")
from PytorchWildlife.models import detection as pw_detection
log(f"  detection import: {time.monotonic()-t0:.1f}s")

t0 = time.monotonic()
log("Importing PytorchWildlife.models.classification...")
from PytorchWildlife.models import classification as pw_classification
log(f"  classification import: {time.monotonic()-t0:.1f}s")

t0 = time.monotonic()
log("Loading MegaDetectorV6 (downloads on first run)...")
pw_detection.MegaDetectorV6(device="cpu", pretrained=True, version="MDV6-yolov9-c")
log(f"  detector loaded: {time.monotonic()-t0:.1f}s")

# WORKAROUND for PyTorch-Wildlife bug: yolov8_base._load_model checks for a file
# named self.MODEL_NAME ("MDV6b-yolov9-c.pt", with a stray 'b') before deciding
# whether to download. But wget.download saves with the URL's filename
# ("MDV6-yolov9-c.pt", no 'b'). So the cache check ALWAYS fails and the 49 MB
# weights file re-downloads on every restart, accumulating "MDV6-yolov9-c (1).pt"
# duplicates. Fix: create a symlink with the buggy MODEL_NAME pointing at the
# real file, and clean up wget's "(N)" duplicates.
import glob, re
ckpt_dir = os.path.join(torch.hub.get_dir(), "checkpoints")
real_path = os.path.join(ckpt_dir, "MDV6-yolov9-c.pt")
buggy_path = os.path.join(ckpt_dir, "MDV6b-yolov9-c.pt")
if os.path.isfile(real_path):
    # Remove wget's "(1)", "(2)", ... duplicates from prior buggy runs
    duplicates = glob.glob(os.path.join(ckpt_dir, "MDV6-yolov9-c (*).pt"))
    for dup in duplicates:
        try:
            os.remove(dup)
            log(f"  removed stale duplicate: {os.path.basename(dup)}")
        except OSError as e:
            log(f"  failed to remove {dup}: {e}")
    # Create symlink that PW's buggy MODEL_NAME check will find next time
    if not os.path.exists(buggy_path):
        try:
            os.symlink("MDV6-yolov9-c.pt", buggy_path)
            log(f"  created cache-fix symlink: MDV6b-yolov9-c.pt → MDV6-yolov9-c.pt")
        except OSError as e:
            log(f"  failed to symlink {buggy_path}: {e}")
    else:
        log(f"  cache-fix symlink already in place")
else:
    log(f"  WARNING: expected weights at {real_path} not found — symlink workaround skipped")

t0 = time.monotonic()
log("Loading AI4GAmazonRainforest classifier (downloads ~188 MB on first run)...")
cls = getattr(pw_classification, "AI4GAmazonRainforest", None)
if cls is not None:
    cls(device="cpu")
    log(f"  classifier loaded: {time.monotonic()-t0:.1f}s")
else:
    log("  classifier not found in module — skipped")

# Show what actually landed on disk so we can verify persistence
hub_dir = torch.hub.get_dir()
checkpoints = os.path.join(hub_dir, "checkpoints")
if os.path.isdir(checkpoints):
    log(f"Cache contents in {checkpoints}:")
    for f in sorted(os.listdir(checkpoints)):
        p = os.path.join(checkpoints, f)
        if os.path.isfile(p):
            mb = os.path.getsize(p) / (1024 * 1024)
            log(f"  {f} ({mb:.1f} MB)")
else:
    log(f"WARNING: no checkpoints dir at {checkpoints}")

log("Pre-warm complete")
PYWARM
}

# Check if venv already exists and has all required packages
if [ -x "$ML_PYTHON" ]; then
  if "$ML_PYTHON" -c "import PytorchWildlife; import librosa; import timm" 2>/dev/null; then
    echo "[ml-setup] ML venv ready at $ML_VENV_DIR"
    warm_model_cache
    exit 0
  fi
  echo "[ml-setup] ML venv exists but missing packages, reinstalling..."
fi

echo "[ml-setup] Creating ML venv at $ML_VENV_DIR..."
uv venv --seed --allow-existing "$ML_VENV_DIR"

ARCH=$(uname -m)
echo "[ml-setup] Installing PyTorch (arch: $ARCH)..."
if [ "$ARCH" = "x86_64" ]; then
  # x86_64: use CPU-only index to avoid huge CUDA download (~2GB → ~200MB)
  uv pip install --python "$ML_PYTHON" torch torchvision --index-url https://download.pytorch.org/whl/cpu
else
  # aarch64/arm64: CPU-only index has no ARM wheels, use default PyPI
  uv pip install --python "$ML_PYTHON" torch torchvision
fi

echo "[ml-setup] Installing PytorchWildlife + missing runtime deps..."
uv pip install --python "$ML_PYTHON" PytorchWildlife lightning omegaconf

echo "[ml-setup] Installing timm (custom Chocó classifier)..."
uv pip install --python "$ML_PYTHON" timm

echo "[ml-setup] Installing librosa + audio spectrogram deps..."
uv pip install --python "$ML_PYTHON" librosa soundfile numpy matplotlib Pillow

# pkg_resources (from setuptools) is needed by yolov5 at runtime but:
# 1. uv's resolver strips setuptools since nothing explicitly depends on it
# 2. setuptools>=78 removed pkg_resources entirely
# So: force-reinstall a version that still includes it, as the LAST step.
echo "[ml-setup] Installing setuptools<75 (provides pkg_resources for yolov5)..."
uv pip install --python "$ML_PYTHON" --reinstall-package setuptools "setuptools<75"

# Verify the import actually works
echo "[ml-setup] Verifying PytorchWildlife + timm imports..."
if "$ML_PYTHON" -c "import PytorchWildlife, timm; print('PytorchWildlife', PytorchWildlife.__version__, 'timm', timm.__version__)" 2>&1; then
  echo "[ml-setup] ML venv ready!"
  warm_model_cache
else
  echo "[ml-setup] ERROR: PytorchWildlife installed but import failed!"
  "$ML_PYTHON" -c "import PytorchWildlife" 2>&1 || true
fi
