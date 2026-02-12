#!/bin/sh
set -e

ML_VENV_DIR="${ML_VENV_DIR:-data/ml-venv}"
ML_PYTHON="$ML_VENV_DIR/bin/python3"

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
echo "[ml-setup] Installing PyTorch (CPU)..."
uv pip install --python "$ML_PYTHON" torch torchvision --index-url https://download.pytorch.org/whl/cpu
echo "[ml-setup] Installing PytorchWildlife..."
uv pip install --python "$ML_PYTHON" PytorchWildlife
echo "[ml-setup] ML venv ready!"
