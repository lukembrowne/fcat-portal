#!/usr/bin/env python3
"""Stage a real BioCLIP (v3) artifact into data/models/ for a local E2E test.

Takes a finished classifier run dir (weights.pt + metrics.json + class_mapping +
confusion_matrix) and lands it under data/models/<name>/ so the portal can
register and serve it. It also retrofits the two fields the current producer
emits but older runs lack — weightsSha256 (computed) + frameworkVersion — so the
registration hash-verification path is exercised, not skipped.

weights.pt is HARDLINKED by default (same volume, zero extra disk; a hardlink is
not a symlink, so the importer accepts it). Use --copy if the source is on a
different filesystem or Docker can't read the hardlink.

  python3 scripts/stage_v3_test_model.py \
      --src /Users/luke/apps/fcat-biochoco-camera-classifier/runs/2026-05-30_bioclip_vith14_last4 \
      --name v4-bioclip-vith14-last4
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

ARTIFACTS = ["weights.pt", "metrics.json", "class_mapping.json", "confusion_matrix.csv"]
MODELS_ROOT = Path(__file__).resolve().parent.parent / "data" / "models"


def sha256_file(path: Path, chunk=1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return "sha256:" + h.hexdigest()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--src", required=True, help="classifier run dir")
    p.add_argument("--name", required=True, help="dest dir name under data/models/")
    p.add_argument("--framework-version", default="open_clip==2.32.0",
                   help="provenance string if metrics.json lacks frameworkVersion")
    p.add_argument("--copy", action="store_true", help="copy weights.pt instead of hardlink")
    p.add_argument("--force", action="store_true", help="overwrite an existing dest dir")
    args = p.parse_args(argv)

    src = Path(args.src)
    dest = MODELS_ROOT / args.name
    for a in ARTIFACTS:
        if not (src / a).exists():
            sys.exit(f"missing {a} in {src}")
    if dest.exists():
        if not args.force:
            sys.exit(f"dest already exists: {dest} (use --force to overwrite)")
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    # weights.pt — hardlink (default) or copy.
    src_w, dest_w = src / "weights.pt", dest / "weights.pt"
    if args.copy:
        print(f"copying weights.pt ({src_w.stat().st_size/1e9:.1f} GB)...")
        shutil.copy2(src_w, dest_w)
    else:
        os.link(src_w, dest_w)
        print(f"hardlinked weights.pt ({src_w.stat().st_size/1e9:.1f} GB, 0 extra disk)")

    # small files: copy class_mapping + confusion_matrix verbatim.
    for a in ["class_mapping.json", "confusion_matrix.csv"]:
        shutil.copy2(src / a, dest / a)

    # metrics.json — retrofit weightsSha256 + frameworkVersion to match the
    # current producer contract (older runs predate those fields).
    metrics = json.loads((src / "metrics.json").read_text())
    if metrics.get("contract", {}).get("version") != "v3" or metrics.get("framework") != "open_clip":
        sys.exit(f"source is not a v3/open_clip artifact: contract={metrics.get('contract')}, framework={metrics.get('framework')}")
    print("hashing weights.pt for weightsSha256 (streamed)...")
    metrics.setdefault("weightsSha256", sha256_file(dest_w))
    metrics.setdefault("frameworkVersion", args.framework_version)
    (dest / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")

    print(f"\nstaged → {dest}")
    print(f"  contract={metrics['contract']['version']} framework={metrics['framework']}")
    print(f"  weightsSha256={metrics['weightsSha256'][:23]}…")
    print(f"  frameworkVersion={metrics['frameworkVersion']}")
    print(f"\nRegister it in the portal UI as dir name: {args.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
