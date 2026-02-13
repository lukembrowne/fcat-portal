---
title: "PytorchWildlife fails to import in Docker despite successful pip install"
date: 2026-02-12
category: build-errors
tags: [docker, python, pytorch, ml, uv, setuptools, pkg_resources, debian]
module: camera-trap
symptoms:
  - "ModuleNotFoundError: No module named 'pkg_resources'"
  - "ImportError: libGL.so.1: cannot open shared object file"
  - "ModuleNotFoundError: No module named 'lightning'"
  - "ModuleNotFoundError: No module named 'omegaconf'"
  - "uv pip install setuptools shows 'Audited' but pkg_resources still missing"
  - "PyTorch wheels not found on Alpine Linux (aarch64)"
---

# PytorchWildlife fails to import in Docker despite successful pip install

## Problem

After `uv pip install PytorchWildlife` completes successfully in a Docker container,
`import PytorchWildlife` fails with a cascade of missing dependencies. This manifested
as **five separate errors** that had to be solved in sequence.

## Root Causes (5 layers)

### 1. Alpine Linux has no PyTorch wheels (aarch64)

PyTorch only publishes `manylinux` (glibc) wheels. Alpine uses musl libc.

**Error:** `No matching distribution found for torch` on aarch64 Alpine.

**Fix:** Switch from `node:22-alpine` to `node:22-slim` (Debian-based, has glibc).

### 2. OpenCV needs libGL on Debian slim

OpenCV (pulled in by `supervision`, a PytorchWildlife dep) needs `libGL.so.1`
which isn't in Debian slim by default.

**Error:** `ImportError: libGL.so.1: cannot open shared object file: No such file or directory`

**Fix:** Add to Dockerfile:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv curl wget libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
```

### 3. setuptools >= 78 removed pkg_resources

`yolov5` (a PytorchWildlife dep) uses `import pkg_resources` at the top level.
`pkg_resources` was part of `setuptools` but was **removed in setuptools ~78+**.
The latest setuptools (82.0.0) installs fine but has no `pkg_resources/` directory.

Additionally, `uv`'s dependency resolver strips `setuptools` during PytorchWildlife
install since nothing in the dependency tree explicitly requires it.

**Error:** `ModuleNotFoundError: No module named 'pkg_resources'`

**What didn't work:**
- Installing setuptools BEFORE PytorchWildlife (uv resolver removes it)
- Installing setuptools AFTER PytorchWildlife without version pin (gets v82, no pkg_resources)
- `uv pip install setuptools` without `--reinstall-package` (uv says "Audited" and skips)

**Fix:** Force-reinstall a pinned older version as the LAST install step:
```sh
uv pip install --python "$ML_PYTHON" --reinstall-package setuptools "setuptools<75"
```

### 4. PytorchWildlife has undeclared runtime dependencies

PytorchWildlife's `pyproject.toml` doesn't list `lightning` or `omegaconf` as
dependencies, but imports them at module load time.

**Errors:**
- `ModuleNotFoundError: No module named 'lightning'`
- `ModuleNotFoundError: No module named 'omegaconf'`

**Fix:** Install them explicitly alongside PytorchWildlife:
```sh
uv pip install --python "$ML_PYTHON" PytorchWildlife lightning omegaconf
```

### 5. Docker user home directory is /nonexistent

The `nextjs` system user has home `/nonexistent`. Multiple Python libs try to
write config there: matplotlib, uv cache, Ultralytics.

**Errors:**
- `Permission denied: '/nonexistent'` (matplotlib)
- `Failed to initialize cache at /nonexistent/.cache/uv` (uv)
- `user config directory '/nonexistent/.config/Ultralytics' is not writable` (YOLO)

**Fix:** Set writable dirs in `docker-entrypoint.sh`:
```sh
export MPLCONFIGDIR=/tmp/matplotlib-config
export UV_CACHE_DIR=/tmp/uv-cache
export YOLO_CONFIG_DIR=/tmp/Ultralytics
```

## Working Solution

### `scripts/ensure-ml-venv.sh` (key parts)

```sh
#!/bin/sh
set -e
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
export UV_LINK_MODE=copy
export MPLCONFIGDIR="${MPLCONFIGDIR:-/tmp/matplotlib-config}"

uv venv --seed --allow-existing "$ML_VENV_DIR"

# PyTorch: use CPU-only index on x86_64, default PyPI on aarch64
uv pip install --python "$ML_PYTHON" torch torchvision

# PytorchWildlife + its undeclared deps
uv pip install --python "$ML_PYTHON" PytorchWildlife lightning omegaconf

# setuptools<75 LAST — uv strips it, and v82+ removed pkg_resources
uv pip install --python "$ML_PYTHON" --reinstall-package setuptools "setuptools<75"
```

### `Dockerfile` runner stage

```dockerfile
FROM node:22-slim AS runner
# NOT Alpine — PyTorch needs glibc
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv curl wget libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
```

### `docker-entrypoint.sh`

```sh
export MPLCONFIGDIR=/tmp/matplotlib-config
export YOLO_CONFIG_DIR=/tmp/Ultralytics
sh scripts/ensure-ml-venv.sh &
exec node server.js
```

## Prevention

1. **Always verify imports, not just installs.** `uv pip install` succeeding does
   NOT mean the package is importable. The verify step in `ensure-ml-venv.sh` caught
   every issue.

2. **Pin setuptools when pkg_resources is needed.** Any project using yolov5 or
   other packages that `import pkg_resources` must pin `setuptools<75`.

3. **Use Debian slim, not Alpine, for ML workloads.** PyTorch/OpenCV ecosystem
   only supports glibc.

4. **Check for undeclared dependencies.** PytorchWildlife doesn't declare
   `lightning` or `omegaconf` — test imports in a clean venv.

5. **Set writable temp dirs for Docker system users.** Any Python lib that writes
   config to `$HOME` will fail for system users with `/nonexistent` home.

## Key Insight: uv's "Audited" trap

When `uv pip install setuptools` says `Audited 1 package in 28ms`, it means uv
sees the package metadata and thinks it's installed — but the actual files may be
missing or the version may lack the module you need. Use `--reinstall-package`
to force a real reinstall.
