#!/usr/bin/env python3
"""
Acoustic indices runner — Müller 2023 / Kümmet 2025 five-index recipe.

Reads config JSON from stdin, computes the five Chocó-validated indices on
each audio file, and streams NDJSON progress/results to stdout.

Indices:
  - Soundscape Saturation (Burivalova 2018, ~50 lines NumPy port)
  - Acoustic Complexity Index (scikit-maad)
  - Frequency Entropy (scikit-maad H_f)
  - Temporal Entropy (scikit-maad H_t)
  - Events per Second (Towsey 2018, ~50 lines NumPy port)

stdin (single JSON line):
  {
    "files": [{"id": 123, "path": "...", "filename": "...wav"}, ...],
    "config": {
      "targetSampleRate": 44100, "windowSeconds": 60,
      "freqLowHz": 50, "freqHighHz": 8000,
      "ssThresholdDb": 9, "epsMinEventSeconds": 0.06
    },
    "config_version": "1.0",
    "diel_periods": ["dawn","midday","dusk","night","other"],
    "diel_period_ranges": {"dawn":[5,7], "midday":[11,13], ...}
  }

stdout (NDJSON):
  {"type": "info", "message": "...", "config_hash": "sha256:abc..."}
  {"type": "progress", "index": 5, "total": 200}
  {"type": "result", "audio_file_id": 123, "soundscape_saturation": 0.41, ...}
  {"type": "skip", "audio_file_id": 124, "reason": "..."}
  {"type": "complete", "total_processed": 198, "total_skipped": 2}
"""

import hashlib
import json
import re
import sys
import time
from pathlib import Path


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def parse_recording_hour(filename: str):
    """Mirror src/lib/audio-filename.ts. Returns (date_str, hour) or (None, None)."""
    m = re.search(r"_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.", filename)
    if not m:
        return None, None
    y, mo, d, h, _, _ = m.groups()
    return f"{y}-{mo}-{d}", int(h)


def assign_diel_period(hour, ranges):
    """Map an hour-of-day to a diel period. `night` wraps midnight."""
    if hour is None:
        return "other"
    for name, (start, end) in ranges.items():
        if start <= end:
            if start <= hour < end:
                return name
        else:
            # Wrap-around (e.g. night 22 → 04). Inclusive at both ends.
            if hour >= start or hour < end:
                return name
    return "other"


def compute_config_hash(config, config_version, maad_version):
    """SHA-256 over canonical JSON of config + version markers."""
    blob = {"config": config, "config_version": config_version, "maad": maad_version}
    canonical = json.dumps(blob, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"sha256:{digest[:16]}"


def soundscape_saturation(y, sr, freq_low, freq_high, threshold_db):
    """
    Port of Burivalova 2018 Soundscape Saturation.

    1. Compute amplitude spectrogram (Towsey-style, log-amplitude).
    2. Restrict to the analysis band.
    3. Per-bin modal background (~mode of the amplitude distribution).
    4. Bin is "occupied" if any time slice exceeds (background + threshold_db).
    5. SS = occupied_bins / total_bins  (range 0–1).
    """
    import numpy as np
    from scipy.signal import stft

    n_per_seg = 1024
    f, _, Zxx = stft(y, fs=sr, nperseg=n_per_seg, noverlap=n_per_seg // 2, padded=False)
    amp = np.abs(Zxx)
    # log-amplitude (dB scale, floor at -120 dB)
    amp_db = 20 * np.log10(np.maximum(amp, 1e-12))

    band = (f >= freq_low) & (f <= freq_high)
    if not band.any():
        return 0.0
    band_db = amp_db[band, :]

    n_bins = band_db.shape[0]
    if n_bins == 0:
        return 0.0

    # Per-bin modal background — use the 10th percentile as a robust proxy
    # for the mode of a noise-dominated distribution. Matches Towsey 2018 §3.1.
    background = np.percentile(band_db, 10, axis=1)

    # Occupied if ANY frame exceeds background + threshold
    occupied = (band_db > (background[:, None] + threshold_db)).any(axis=1)
    return float(occupied.sum() / n_bins)


def events_per_second(y, sr, freq_low, freq_high, min_event_seconds):
    """
    Port of Towsey 2018 events-per-second.

    1. Band-limited energy envelope (RMS in short frames).
    2. Smoothed background = 10th-percentile of envelope.
    3. Mark frames where envelope > (background + 3 dB equivalent ~factor 1.4).
    4. Cluster consecutive marked frames; count clusters >= min_event_seconds.
    5. EPS = events / duration_seconds.
    """
    import numpy as np
    from scipy.signal import stft

    n_per_seg = 1024
    hop = n_per_seg // 2
    f, t, Zxx = stft(y, fs=sr, nperseg=n_per_seg, noverlap=hop, padded=False)
    if t.size < 2:
        return 0.0
    band = (f >= freq_low) & (f <= freq_high)
    if not band.any():
        return 0.0
    power = np.abs(Zxx[band, :]) ** 2
    envelope = np.sqrt(power.mean(axis=0))

    background = np.percentile(envelope, 10)
    # +3 dB ≈ factor 1.4 over background
    threshold = background * 1.4
    mask = envelope > threshold

    frame_seconds = t[1] - t[0] if t.size >= 2 else 0.0
    if frame_seconds <= 0:
        return 0.0
    min_frames = max(1, int(round(min_event_seconds / frame_seconds)))

    # Count clusters of consecutive True frames that meet the minimum length.
    events = 0
    run = 0
    for v in mask:
        if v:
            run += 1
        else:
            if run >= min_frames:
                events += 1
            run = 0
    if run >= min_frames:
        events += 1

    duration_s = len(y) / sr
    if duration_s <= 0:
        return 0.0
    return float(events / duration_s)


def compute_indices(path: str, config, maad_alpha, maad_features):
    """Returns a dict of the five indices, or raises a short-string Exception."""
    import numpy as np
    import librosa

    target_sr = int(config["targetSampleRate"])
    window_s = float(config["windowSeconds"])
    freq_low = int(config["freqLowHz"])
    freq_high = int(config["freqHighHz"])
    ss_thresh = float(config["ssThresholdDb"])
    eps_min = float(config["epsMinEventSeconds"])

    y, sr = librosa.load(path, sr=target_sr, mono=True)

    # Post-load sanity: filesystem header can lie about duration for truncated WAVs.
    if len(y) < int(target_sr * 30):
        raise ValueError(f"file shorter than 30 s after decode ({len(y)/sr:.1f} s)")

    # Take the first `window_s` seconds — matches Kümmet 2025 cadence (one
    # 1-minute file, full duration).
    win_samples = int(window_s * sr)
    if len(y) > win_samples:
        y = y[:win_samples]

    # ACI / H_t / H_f via scikit-maad
    Sxx_power, tn, fn, _ = maad_alpha.spectrogram(
        y, sr, nperseg=1024, noverlap=512, mode="psd"
    )
    # Limit to analysis band for ACI; entropies use full spectrum to match papers.
    band_mask = (fn >= freq_low) & (fn <= freq_high)
    Sxx_band = Sxx_power[band_mask, :] if band_mask.any() else Sxx_power

    _, _, aci_total = maad_features.acoustic_complexity_index(Sxx_band)
    # scikit-maad: frequency_entropy(Sxx) -> Hf (across freq bins of spectrogram)
    #              temporal_entropy(s)    -> Ht (across time, on the waveform)
    freq_entropy = maad_features.frequency_entropy(Sxx_power)
    temp_entropy = maad_features.temporal_entropy(y)

    ss = soundscape_saturation(y, sr, freq_low, freq_high, ss_thresh)
    eps = events_per_second(y, sr, freq_low, freq_high, eps_min)

    # Coerce numpy scalars to plain floats so json.dumps is happy.
    # frequency_entropy can return a tuple in some maad versions — take element 0.
    if isinstance(freq_entropy, tuple):
        freq_entropy = freq_entropy[0]

    return {
        "soundscape_saturation": float(ss),
        "acoustic_complexity_index": float(aci_total),
        "frequency_entropy": float(freq_entropy),
        "temporal_entropy": float(temp_entropy),
        "events_per_second": float(eps),
    }


def main():
    raw = sys.stdin.readline().strip()
    if not raw:
        emit({"type": "error", "message": "No config received on stdin"})
        sys.exit(1)

    payload = json.loads(raw)
    files = payload.get("files", [])
    config = payload.get("config", {})
    config_version = payload.get("config_version", "0.0")
    diel_ranges = {
        k: tuple(v) for k, v in payload.get("diel_period_ranges", {}).items()
    }

    # Import heavy deps once (cost ~1–2 s); surface ImportError clearly.
    try:
        import maad
        from maad import sound as maad_alpha
        from maad import features as maad_features
    except ImportError as exc:
        emit({"type": "error", "message": f"scikit-maad import failed: {exc}"})
        sys.exit(1)

    maad_version = getattr(maad, "__version__", "unknown")
    config_hash = compute_config_hash(config, config_version, maad_version)

    emit({
        "type": "info",
        "message": (
            f"Calculando índices acústicos para {len(files)} archivos "
            f"(maad {maad_version}, config_version {config_version})"
        ),
        "config_hash": config_hash,
    })

    total = len(files)
    processed = 0
    skipped = 0
    start = time.time()

    for idx, f in enumerate(files, start=1):
        audio_file_id = f.get("id")
        path = f.get("path")
        filename = f.get("filename", "")

        if not path or not Path(path).is_file():
            skipped += 1
            emit({
                "type": "skip",
                "audio_file_id": audio_file_id,
                "reason": "archivo no encontrado en cache local",
            })
            emit({"type": "progress", "index": idx, "total": total})
            continue

        try:
            indices = compute_indices(path, config, maad_alpha, maad_features)
        except Exception as exc:  # noqa: BLE001 — broad catch is intentional
            skipped += 1
            reason = str(exc) or exc.__class__.__name__
            print(
                f"[acoustic-indices] skip {filename}: {reason}",
                file=sys.stderr,
                flush=True,
            )
            emit({
                "type": "skip",
                "audio_file_id": audio_file_id,
                "reason": reason[:200],
            })
            emit({"type": "progress", "index": idx, "total": total})
            continue

        recorded_date, hour = parse_recording_hour(filename)
        diel_period = assign_diel_period(hour, diel_ranges)

        emit({
            "type": "result",
            "audio_file_id": audio_file_id,
            "config_hash": config_hash,
            "recorded_date": recorded_date,
            "diel_period": diel_period,
            **indices,
        })
        processed += 1
        emit({"type": "progress", "index": idx, "total": total})

    elapsed = time.time() - start
    emit({
        "type": "info",
        "message": (
            f"Listo en {elapsed:.1f}s — {processed} procesados, {skipped} omitidos"
        ),
    })
    emit({
        "type": "complete",
        "total_processed": processed,
        "total_skipped": skipped,
    })


if __name__ == "__main__":
    main()
