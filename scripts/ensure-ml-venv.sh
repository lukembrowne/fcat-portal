#!/bin/sh
set -e

ML_VENV_DIR="${ML_VENV_DIR:-data/ml-venv}"
ML_PYTHON="$ML_VENV_DIR/bin/python3"

# Suppress hardlink warnings in Docker (different filesystems)
export UV_LINK_MODE=copy

# Check if venv already exists and has pytorch-wildlife
if [ -x "$ML_PYTHON" ]; then
  if "$ML_PYTHON" -c "import PytorchWildlife" 2>/dev/null; then
    echo "[ml-setup] ML venv ready at $ML_VENV_DIR"
    exit 0
  fi
  echo "[ml-setup] ML venv exists but PytorchWildlife missing, reinstalling..."
fi

echo "[ml-setup] Creating ML venv at $ML_VENV_DIR..."
uv venv "$ML_VENV_DIR"

ARCH=$(uname -m)
echo "[ml-setup] Installing PyTorch (arch: $ARCH)..."
if [ "$ARCH" = "x86_64" ]; then
  # x86_64: use CPU-only index to avoid huge CUDA download (~2GB → ~200MB)
  uv pip install --python "$ML_PYTHON" torch torchvision --index-url https://download.pytorch.org/whl/cpu
else
  # aarch64/arm64: CPU-only index has no ARM wheels, use default PyPI
  uv pip install --python "$ML_PYTHON" torch torchvision
fi

echo "[ml-setup] Installing PytorchWildlife..."
uv pip install --python "$ML_PYTHON" PytorchWildlife

echo "[ml-setup] ML venv ready!"
