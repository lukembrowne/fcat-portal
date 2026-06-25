#!/usr/bin/env python3
"""
BirdNET audio analysis runner.

Reads config JSON from stdin, runs BirdNET-Analyzer on a directory of audio files,
parses CSV results, and streams NDJSON progress to stdout.

stdin (single JSON line):
  {"audio_dir": "/path/to/audio/", "output_dir": "/tmp/birdnet-XXXX",
   "lat": -0.3, "lon": -79.2, "week": 12, "min_conf": 0.1, "threads": 3,
   "total_files": 50, "sensitivity": 1.0, "overlap": 1.0}

stdout (NDJSON):
  {"type": "version", "value": "birdnet-analyzer@1.5.1; model=BirdNET_GLOBAL_6K_V2.4"}
  {"type": "info", "message": "..."}
  {"type": "progress", "index": 5, "total": 50}
  {"type": "result", "file": "recording.wav", "detections": [...]}
  {"type": "complete", "total_processed": 50, "total_detections": 312}

Also supports `--print-version`: prints the model version string and exits
without reading stdin (used by the backfill maintenance script).
"""

import json
import os
import sys
import csv
import tempfile
import shutil
import subprocess
import importlib.metadata
from pathlib import Path
from collections import defaultdict


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def get_model_version():
    """Return a self-describing version string for the BirdNET model used.

    Combines the installed birdnet-analyzer pip version with the underlying
    TensorFlow model checkpoint name when available, e.g.
    `birdnet-analyzer@1.5.1; model=BirdNET_GLOBAL_6K_V2.4`. Degrades
    gracefully to package-only (or "unknown") if anything can't be read, so
    a missing/renamed attribute never breaks an analysis run.
    """
    try:
        pkg_version = importlib.metadata.version("birdnet-analyzer")
    except importlib.metadata.PackageNotFoundError:
        pkg_version = "unknown"
    except Exception:
        pkg_version = "unknown"

    model_name = None
    try:
        from birdnet_analyzer import config as bn_config

        model_name = getattr(bn_config, "MODEL_VERSION", None)
        if not model_name:
            model_path = getattr(bn_config, "MODEL_PATH", None)
            if model_path:
                # Strip directory + extension, e.g.
                # "checkpoints/V2.4/BirdNET_GLOBAL_6K_V2.4_Model_FP16.tflite"
                # -> "BirdNET_GLOBAL_6K_V2.4_Model_FP16"
                model_name = os.path.splitext(os.path.basename(str(model_path)))[0]
    except Exception:
        model_name = None

    if model_name:
        return f"birdnet-analyzer@{pkg_version}; model={model_name}"
    return f"birdnet-analyzer@{pkg_version}"


def main():
    # Backfill / introspection shortcut: print the version string and exit
    # without reading stdin. Used by scripts/backfill-birdnet-model-version.mjs.
    if "--print-version" in sys.argv[1:]:
        print(get_model_version(), flush=True)
        return

    raw = sys.stdin.readline().strip()
    if not raw:
        emit({"type": "error", "message": "No config received on stdin"})
        sys.exit(1)

    config = json.loads(raw)
    audio_dir = config["audio_dir"]
    output_dir = config.get("output_dir") or tempfile.mkdtemp(prefix="birdnet-")
    lat = config.get("lat", -0.3)
    lon = config.get("lon", -79.2)
    week = config.get("week", -1)
    min_conf = config.get("min_conf", 0.1)
    threads = config.get("threads", 3)
    total_files = config.get("total_files", 0)
    sensitivity = config.get("sensitivity", 1.0)
    overlap = config.get("overlap", 1.0)

    emit({"type": "info", "message": f"Iniciando análisis BirdNET ({total_files} archivos, {threads} threads, lat={lat}, lon={lon}, week={week}, min_conf={min_conf})..."})

    # Emit the real model version BEFORE any result message so the Node side
    # can tag every detection/identification with it.
    model_version = get_model_version()
    emit({"type": "version", "value": model_version})
    emit({"type": "info", "message": f"Versión del modelo: {model_version}"})

    # Count audio files in input dir to report
    audio_extensions = {".wav", ".mp3", ".flac", ".ogg", ".aac", ".m4a"}
    found_audio = 0
    if os.path.isdir(audio_dir):
        for f in os.listdir(audio_dir):
            if os.path.splitext(f)[1].lower() in audio_extensions:
                found_audio += 1
    emit({"type": "info", "message": f"Encontrados {found_audio} archivos de audio en {audio_dir}"})

    os.makedirs(output_dir, exist_ok=True)

    # Run BirdNET-Analyzer via CLI
    cmd = [
        sys.executable, "-m", "birdnet_analyzer.analyze",
        audio_dir,
        "-o", output_dir,
        "--rtype", "csv",
        "--lat", str(lat),
        "--lon", str(lon),
        "--week", str(week),
        "--min_conf", str(min_conf),
        "--sensitivity", str(sensitivity),
        "--threads", str(threads),
        "--overlap", str(overlap),
        "--locale", "es",
    ]

    emit({"type": "info", "message": f"Ejecutando: {' '.join(cmd[:6])}..."})

    import time
    start_time = time.time()

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # merge stderr into stdout so we capture all BirdNET logs
            text=True,
            bufsize=1,
        )

        # Stream BirdNET output line-by-line so the Node side sees live progress
        processed_files = set()
        denominator = total_files if total_files > 0 else found_audio
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip()
            if not line:
                continue

            lower = line.lower()
            # Surface meaningful BirdNET log lines; skip TF/warning noise
            if any(tok in lower for tok in ("analyzing", "error", "loaded", "model", "finished", "done", "species")):
                emit({"type": "info", "message": f"[birdnet-cli] {line[:300]}"})

            # BirdNET prints lines like "Analyzing audio file 3/50: /path/recording.wav"
            if "analyzing" in lower:
                for part in line.split():
                    if "/" in part and "." in part:
                        processed_files.add(part)
                if denominator > 0:
                    idx = len(processed_files)
                    emit({"type": "progress", "index": idx, "total": denominator})
                    elapsed = time.time() - start_time
                    if idx > 0:
                        rate = idx / elapsed
                        remaining = (denominator - idx) / rate if rate > 0 else 0
                        emit({
                            "type": "info",
                            "message": f"Progreso: {idx}/{denominator} ({rate:.2f} archivos/s, ~{remaining:.0f}s restante)",
                        })

        proc.wait()

        if proc.returncode != 0:
            emit({"type": "error", "message": f"BirdNET exited with code {proc.returncode}"})
            sys.exit(1)

        total_elapsed = time.time() - start_time
        emit({"type": "info", "message": f"Análisis BirdNET finalizado en {total_elapsed:.1f}s. Parseando CSVs..."})

    except FileNotFoundError:
        emit({"type": "error", "message": "birdnet_analyzer module not found"})
        sys.exit(1)

    # Parse CSV results from output directory
    total_detections = 0
    total_processed = 0
    results_by_file = defaultdict(list)

    csv_files = list(Path(output_dir).glob("*.csv"))
    emit({"type": "info", "message": f"Parseando {len(csv_files)} archivos CSV de resultados..."})

    for csv_path in csv_files:
        try:
            with open(csv_path, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    # BirdNET CSV columns: Start (s), End (s), Scientific name, Common name, Confidence
                    scientific_name = row.get("Scientific name", "").strip()
                    common_name = row.get("Common name", "").strip()
                    confidence = float(row.get("Confidence", 0))
                    start = float(row.get("Start (s)", 0))
                    end = float(row.get("End (s)", 0))

                    if not scientific_name:
                        continue

                    # The CSV filename maps back to the original audio file
                    # BirdNET names output CSVs based on input filenames
                    source_file = csv_path.stem  # e.g., "recording.BirdNET" -> "recording"
                    # Remove BirdNET suffix if present
                    if ".BirdNET" in csv_path.name:
                        source_file = csv_path.name.split(".BirdNET")[0]

                    results_by_file[source_file].append({
                        "start": start,
                        "end": end,
                        "scientific_name": scientific_name,
                        "common_name": common_name,
                        "confidence": confidence,
                    })
                    total_detections += 1
        except Exception as e:
            emit({"type": "info", "message": f"Error parsing {csv_path.name}: {e}"})

    # Emit per-file results
    for filename, detections in results_by_file.items():
        total_processed += 1
        emit({
            "type": "result",
            "file": filename,
            "detections": detections,
        })
        if total_files > 0:
            emit({
                "type": "progress",
                "index": total_processed,
                "total": total_files,
            })

    # Also count files that produced no detections
    # by scanning the audio directory
    audio_extensions = {".wav", ".mp3", ".flac", ".ogg", ".aac", ".m4a"}
    if os.path.isdir(audio_dir):
        for f in os.listdir(audio_dir):
            ext = os.path.splitext(f)[1].lower()
            if ext in audio_extensions:
                base = os.path.splitext(f)[0]
                if base not in results_by_file:
                    total_processed += 1
                    emit({
                        "type": "result",
                        "file": f,
                        "detections": [],
                    })

    # Clean up temp output dir
    try:
        shutil.rmtree(output_dir)
    except Exception:
        pass

    emit({
        "type": "complete",
        "total_processed": total_processed,
        "total_detections": total_detections,
    })


if __name__ == "__main__":
    main()
