---
title: "ML venv: host-run python gives false ModuleNotFoundError (verify inside the container)"
date: 2026-06-15
category: runtime-errors
module: ml-pipeline
tags: [docker, ml-venv, uv, open_clip, bioclip, diagnostics, false-negative]
symptoms:
  - "`data/ml-venv/bin/python3 -c 'import open_clip'` → ModuleNotFoundError, but the package IS installed"
  - "Thought a deployed ML dependency (open_clip_torch) never installed on prod"
  - "Need to add a new ML Python package and aren't sure how it reaches the persistent venv"
---

# ML venv: host-run python gives false ModuleNotFoundError

## Problem

While confirming whether the BioCLIP (contract v3) serving deps were live on
prod, this check was run **over SSH on the host shell**:

```bash
ssh digitalocean "cd /root/opt/fcat-portal && data/ml-venv/bin/python3 -c 'import open_clip'"
# → ModuleNotFoundError: No module named 'open_clip'
```

That led to the wrong conclusion that the `9b5fe31 feat(ml-venv): install
open_clip_torch` deploy had failed and the venv needed deleting/rebuilding.

## Root cause

`data/ml-venv/` is created **inside the container** by `scripts/ensure-ml-venv.sh`
(via `uv`). A venv's `bin/python3` is a thin launcher tied to the base
interpreter and `site-packages` layout of the environment that built it — here,
the container's `/usr/local/bin/python3.11` and the container filesystem.

Running that same `bin/python3` from the **host** resolves a different (or
absent) base interpreter and cannot see the container-built `site-packages`, so
imports spuriously fail. It is a **false negative**, not a real missing package.

The deploy had actually worked. The container boot log showed:

```
[ml-setup] ML venv exists but missing packages, reinstalling...
[ml-setup] Installing open_clip_torch (BioCLIP ... contract v3)...
PytorchWildlife 1.2.4.2 timm 1.0.24 open_clip 2.32.0
[ml-setup] ML venv ready!
```

## Solution

Always exercise the ML venv **inside the container**:

```bash
# WRONG — host shell, false negative
ssh digitalocean "cd /root/opt/fcat-portal && data/ml-venv/bin/python3 -c 'import open_clip'"

# CORRECT — inside the container
ssh digitalocean "cd /root/opt/fcat-portal && \
  docker compose exec -T portal data/ml-venv/bin/python3 -c \
  'import open_clip, timm, PytorchWildlife; print(open_clip.__version__)'"
# → open_clip 2.32.0
```

The boot log is also authoritative for what was installed:

```bash
docker compose logs portal 2>&1 | grep -i 'ml-setup\|open_clip\|venv ready'
```

## Adding a new ML package sustainably (do NOT delete the venv)

The readiness gate in `scripts/ensure-ml-venv.sh` already makes this safe and
incremental — deleting `data/ml-venv/` is a last resort, not the routine path.

1. Add the install line, e.g. `uv pip install --python "$ML_PYTHON" <pkg>`.
2. Add the import to the **readiness check** (the `if "$ML_PYTHON" -c "import
   PytorchWildlife; ... import open_clip; ..."` line near the top).
3. Deploy, then `docker compose restart portal`.

On restart the gate sees the new package missing, prints *"ML venv exists but
missing packages, reinstalling…"*, and runs the install block. That block is
`uv venv --seed --allow-existing` + `uv pip install` — it **reuses** the existing
venv and `uv` skips already-satisfied packages, so nothing is wiped. The reinstall
runs in the background at boot, so ML is unavailable for a few minutes until
`[ml-setup] ML venv ready!` appears.

## Prevention

- Treat `data/ml-venv/bin/python3` as a **container-only** binary. Any
  host-side invocation (bare or over SSH) is meaningless — always wrap in
  `docker compose exec -T portal …`. This is the ML-venv instance of the
  general CLAUDE.md rule: *verify paths resolve inside the container, not just
  locally.*
- To check whether a dependency is live, prefer the boot log
  (`docker compose logs portal | grep ml-setup`) or an in-container import — never
  a host-run import.
</content>
</invoke>
