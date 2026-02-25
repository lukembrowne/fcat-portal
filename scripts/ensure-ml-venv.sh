#!/bin/sh
set -e

ML_VENV_DIR="${ML_VENV_DIR:-data/ml-venv}"
ML_PYTHON="$ML_VENV_DIR/bin/python3"

# Docker: nextjs user home is /nonexistent, needs writable dirs
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
export UV_LINK_MODE=copy
export MPLCONFIGDIR="${MPLCONFIGDIR:-/tmp/matplotlib-config}"

# Check if venv already exists and has all required packages
if [ -x "$ML_PYTHON" ]; then
  if "$ML_PYTHON" -c "import PytorchWildlife; import librosa" 2>/dev/null; then
    echo "[ml-setup] ML venv ready at $ML_VENV_DIR"
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

echo "[ml-setup] Installing librosa + audio spectrogram deps..."
uv pip install --python "$ML_PYTHON" librosa soundfile numpy matplotlib Pillow

# pkg_resources (from setuptools) is needed by yolov5 at runtime but:
# 1. uv's resolver strips setuptools since nothing explicitly depends on it
# 2. setuptools>=78 removed pkg_resources entirely
# So: force-reinstall a version that still includes it, as the LAST step.
echo "[ml-setup] Installing setuptools<75 (provides pkg_resources for yolov5)..."
uv pip install --python "$ML_PYTHON" --reinstall-package setuptools "setuptools<75"

# Verify the import actually works
echo "[ml-setup] Verifying PytorchWildlife import..."
if "$ML_PYTHON" -c "import PytorchWildlife; print('version:', PytorchWildlife.__version__)" 2>&1; then
  echo "[ml-setup] ML venv ready!"
else
  echo "[ml-setup] ERROR: PytorchWildlife installed but import failed!"
  "$ML_PYTHON" -c "import PytorchWildlife" 2>&1 || true
fi
