#!/usr/bin/env python3
"""Phase 2 cost gate (Workstream E): is BioCLIP cheap enough to serve here?

Measures, on THIS box, what it costs to serve a BioCLIP ViT-H/14 classifier
alongside MegaDetector — the numbers that decide GO / NO-GO before a v3 model
goes live. Accuracy is settled; this answers "will the server handle it?".

It reports four things and then a verdict:
  1. Machine     — CPUs, torch threads, total RAM, container memory limit.
  2. Cold start  — seconds to load each model + the first (graph-building) forward.
  3. Latency     — per-crop P50/P95/P99 and throughput at batch=1 (prod serves 1).
  4. Memory      — PEAK resident memory with BOTH models loaded, vs the limit.

Run it on the actual prod droplet (or an identical instance), in the ML venv,
with the SAME thread settings as prod:

  data/ml-venv/bin/python3 scripts/profile-bioclip-cost.py \
      --ram-headroom 0.8 --latency-slo-ms 800 --target-imgs-per-s 1.0

First run downloads the ~2.5 GB BioCLIP checkpoint from HuggingFace (needs ~5 GB
free disk + egress). To smoke-test the SCRIPT itself without that download, use a
tiny offline arch and skip the detector:

  python3 scripts/profile-bioclip-cost.py --arch open_clip:ViT-B-32 --no-detector --iters 10

The verdict is advisory — it just applies the thresholds you pass. Fill the
numbers into docs/operations/bioclip-cost-gate-decision-sheet.md.
"""
from __future__ import annotations

import argparse
import os
import resource
import sys
import time

# Match prod thread caps BEFORE importing torch (native libs read these at load).
_cap = str(max(1, (os.cpu_count() or 2) - 1))
os.environ.setdefault("OMP_NUM_THREADS", os.environ.get("OMP_NUM_THREADS", _cap))
os.environ.setdefault("MKL_NUM_THREADS", os.environ.get("MKL_NUM_THREADS", _cap))


# --------------------------------------------------------------------------- #
# Machine introspection (Linux /proc + cgroup; degrades on other platforms).
# --------------------------------------------------------------------------- #
def _total_ram_gb():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / (1024 * 1024)  # kB -> GB
    except OSError:
        pass
    return None


def _cgroup_limit_gb():
    """Container memory ceiling (cgroup v2 then v1). None if unlimited/unknown."""
    candidates = [
        "/sys/fs/cgroup/memory.max",                 # cgroup v2
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",  # cgroup v1
    ]
    for path in candidates:
        try:
            raw = open(path).read().strip()
        except OSError:
            continue
        if raw == "max":
            return None
        try:
            val = int(raw)
        except ValueError:
            continue
        gb = val / (1024 ** 3)
        # cgroup v1 reports a huge sentinel when unlimited; ignore it.
        total = _total_ram_gb()
        if total and gb > total * 4:
            return None
        return gb
    return None


def _peak_rss_gb():
    """Peak resident set size of this process so far. ru_maxrss is KB on Linux."""
    kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "darwin":  # macOS reports bytes
        kb /= 1024
    return kb / (1024 * 1024)


def _torch_threads():
    import torch
    return torch.get_num_threads()


# --------------------------------------------------------------------------- #
# Model loading
# --------------------------------------------------------------------------- #
def load_detector(device):
    """MegaDetectorV6 — the model BioCLIP must co-exist with. Best-effort."""
    from PytorchWildlife.models import detection as pw_detection

    return pw_detection.MegaDetectorV6(
        device=device, pretrained=True, version="MDV6-yolov9-c"
    )


def load_bioclip(arch, num_classes, device):
    """Reconstruct the BioCLIP classifier exactly as the portal does."""
    import open_clip
    import torch
    import torch.nn as nn

    # Same prefix handling as the portal's reconstruction: hf-hub:<repo> loads
    # the hub checkpoint; open_clip:<arch> builds a plain (offline) arch.
    if arch.startswith("open_clip:"):
        oc_model, _, _ = open_clip.create_model_and_transforms(
            arch[len("open_clip:"):], pretrained=None
        )
    else:
        oc_model, _, _ = open_clip.create_model_and_transforms(arch)
    trunk = oc_model.visual
    embed_dim = int(getattr(trunk, "output_dim", None) or trunk.proj.shape[-1])

    class _OpenClipModule(nn.Module):
        def __init__(self, trunk, embed_dim, num_classes):
            super().__init__()
            self.trunk = trunk
            self.head = nn.Linear(embed_dim, num_classes)

        def forward(self, x):
            feats = self.trunk(x)
            if isinstance(feats, (tuple, list)):
                feats = feats[0]
            return self.head(feats)

    model = _OpenClipModule(trunk, embed_dim, num_classes).eval().to(device)
    return model


# --------------------------------------------------------------------------- #
# Timing
# --------------------------------------------------------------------------- #
def time_latency(model, device, iters, image_size=224):
    import torch

    x = torch.randn(1, 3, image_size, image_size, device=device)
    with torch.no_grad():
        t0 = time.perf_counter()
        model(x)  # first forward = cold (graph build / lazy init)
        cold_ms = (time.perf_counter() - t0) * 1000

        times = []
        for _ in range(iters):
            t = time.perf_counter()
            model(x)
            times.append((time.perf_counter() - t) * 1000)
    times.sort()

    def pct(p):
        return times[min(len(times) - 1, int(round(p / 100 * len(times))))]

    return {
        "cold_ms": cold_ms,
        "p50_ms": times[len(times) // 2],
        "p95_ms": pct(95),
        "p99_ms": pct(99),
        "mean_ms": sum(times) / len(times),
        "throughput_imgs_per_s": 1000.0 / (sum(times) / len(times)),
    }


# --------------------------------------------------------------------------- #
def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--arch", default="hf-hub:imageomics/bioclip-2.5-vith14")
    p.add_argument("--device", default="cpu", help="prod is CPU; default cpu")
    p.add_argument("--num-classes", type=int, default=25)
    p.add_argument("--iters", type=int, default=50)
    p.add_argument("--no-detector", action="store_true", help="skip MegaDetector co-load")
    p.add_argument("--ram-headroom", type=float, default=0.8,
                   help="peak RSS must stay under this fraction of the memory limit")
    p.add_argument("--ram-limit-gb", type=float, default=None,
                   help="override the auto-detected cgroup limit")
    p.add_argument("--latency-slo-ms", type=float, default=None,
                   help="P95 per-crop budget (ms); omit to skip the latency gate")
    p.add_argument("--target-imgs-per-s", type=float, default=None,
                   help="required throughput; omit to skip the throughput gate")
    p.add_argument("--crops-per-image", type=float, default=1.5,
                   help="avg animal crops per photo, for a per-image latency estimate")
    args = p.parse_args(argv)

    print("=" * 70)
    print("BioCLIP cost gate (Phase 2 / Workstream E)")
    print("=" * 70)

    # 1. Machine ------------------------------------------------------------ #
    total_ram = _total_ram_gb()
    limit = args.ram_limit_gb if args.ram_limit_gb is not None else _cgroup_limit_gb()
    print("\n[1] Machine")
    print(f"    logical CPUs        : {os.cpu_count()}")
    print(f"    torch threads       : {_torch_threads()}")
    print(f"    total RAM           : {total_ram:.1f} GB" if total_ram else "    total RAM           : unknown")
    print(f"    container mem limit : {limit:.1f} GB" if limit else "    container mem limit : unlimited/unknown (pass --ram-limit-gb)")

    # 2. Cold start --------------------------------------------------------- #
    print("\n[2] Cold start (model load)")
    detector = None
    if not args.no_detector:
        t = time.perf_counter()
        try:
            detector = load_detector(args.device)
            print(f"    MegaDetectorV6 load : {time.perf_counter() - t:.1f} s")
        except Exception as e:  # noqa: BLE001
            print(f"    MegaDetectorV6 load : FAILED ({e}) — co-residency NOT measured")
    else:
        print("    MegaDetectorV6 load : skipped (--no-detector)")

    t = time.perf_counter()
    model = load_bioclip(args.arch, args.num_classes, args.device)
    print(f"    BioCLIP load        : {time.perf_counter() - t:.1f} s  ({args.arch})")

    # 3. Latency ------------------------------------------------------------ #
    print(f"\n[3] Latency (batch=1, {args.iters} iters, device={args.device})")
    lat = time_latency(model, args.device, args.iters)
    print(f"    first forward (cold): {lat['cold_ms']:.0f} ms")
    print(f"    P50 / P95 / P99     : {lat['p50_ms']:.0f} / {lat['p95_ms']:.0f} / {lat['p99_ms']:.0f} ms per crop")
    print(f"    throughput          : {lat['throughput_imgs_per_s']:.1f} crops/s")
    per_image_p95 = lat["p95_ms"] * args.crops_per_image
    print(f"    est. P95 per image  : {per_image_p95:.0f} ms  (@ {args.crops_per_image} crops/image)")

    # 4. Memory ------------------------------------------------------------- #
    peak = _peak_rss_gb()
    print("\n[4] Memory (both models resident)")
    print(f"    peak RSS            : {peak:.2f} GB")
    if limit:
        print(f"    peak / limit        : {100 * peak / limit:.0f} %  (headroom target ≤ {100 * args.ram_headroom:.0f} %)")

    # 5. Verdict ------------------------------------------------------------ #
    print("\n[5] Verdict")
    reasons = []
    go = True
    if limit:
        if peak > args.ram_headroom * limit:
            go = False
            reasons.append(f"NO-GO: peak RSS {peak:.2f} GB exceeds {100*args.ram_headroom:.0f}% of {limit:.1f} GB limit")
        else:
            reasons.append(f"ok: memory {peak:.2f} GB within {100*args.ram_headroom:.0f}% of {limit:.1f} GB")
    else:
        go = None
        reasons.append("unknown: no memory limit detected — pass --ram-limit-gb to gate on RAM")
    if args.latency_slo_ms is not None:
        if lat["p95_ms"] > args.latency_slo_ms:
            go = False
            reasons.append(f"NO-GO: P95 {lat['p95_ms']:.0f} ms exceeds SLO {args.latency_slo_ms:.0f} ms")
        else:
            reasons.append(f"ok: P95 {lat['p95_ms']:.0f} ms within SLO {args.latency_slo_ms:.0f} ms")
    if args.target_imgs_per_s is not None:
        if lat["throughput_imgs_per_s"] < args.target_imgs_per_s:
            go = False
            reasons.append(f"NO-GO: throughput {lat['throughput_imgs_per_s']:.1f} < target {args.target_imgs_per_s:.1f} crops/s")
        else:
            reasons.append(f"ok: throughput {lat['throughput_imgs_per_s']:.1f} ≥ target {args.target_imgs_per_s:.1f} crops/s")
    if detector is None and not args.no_detector:
        reasons.append("CAUTION: detector did not load — RSS is BioCLIP-only, not true co-residency")

    for r in reasons:
        print(f"    - {r}")
    verdict = {True: "GO ✅", False: "NO-GO ⛔", None: "INCONCLUSIVE ❔"}[go]
    print(f"\n    ==> {verdict}")
    print("\n    Record these numbers in docs/operations/bioclip-cost-gate-decision-sheet.md")
    return 0 if go else 1


if __name__ == "__main__":
    raise SystemExit(main())
