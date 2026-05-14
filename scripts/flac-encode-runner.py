#!/usr/bin/env python3
"""
FLAC encode runner — re-encode WAV → FLAC (lossless) for the audio compression job.

Reads a JSON payload from stdin (list of files with `id` and `wav_path`), encodes
each file with python-soundfile in a ProcessPoolExecutor, verifies the round-trip
is bit-identical (shape + sample rate + MD5-of-bytes), and streams NDJSON per-file
results to stdout. The Node-side caller is responsible for replacing the file on
Drive and updating the DB row.

stdin (single JSON line):
  {
    "files": [{"id": 123, "wav_path": "/data/cache/audio/45/AM_..._063000.wav"}, ...],
    "config": {"compression_level": 0.8, "subtype": "PCM_16", "workers": 3}
  }

stdout (NDJSON, one line per message):
  {"type": "info", "message": "..."}
  {"type": "progress", "index": 5, "total": 200}
  {"type": "result", "audio_file_id": 123, "verdict": "compressed",
   "wav_size": ..., "flac_size": ..., "flac_path": "..."}
  {"type": "result", "audio_file_id": 124, "verdict": "non_compressible",
   "wav_size": ..., "flac_size": ...}
  {"type": "skip", "audio_file_id": 125, "reason": "already_flac"}
  {"type": "error", "message": "..."}     # fatal only (e.g. import error)
  {"type": "complete", "total_processed": 198, "total_skipped": 2}

Skip reasons (distinct strings for ops): already_flac, empty_wav, corrupt_wav,
channel_or_length_mismatch, sample_rate_mismatch, samples_diverged,
oom_during_encode, unknown.
"""

import hashlib
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def classify_exception(exc) -> str:
    """Map a generic exception to one of the well-known skip reasons."""
    name = exc.__class__.__name__
    msg = str(exc).lower()
    if name == "MemoryError":
        return "oom_during_encode"
    if name == "LibsndfileError" or "libsndfile" in msg or "soundfile" in msg:
        return "corrupt_wav"
    if "empty" in msg:
        return "empty_wav"
    return "unknown"


def _md5_bytes(buf) -> bytes:
    h = hashlib.md5()
    h.update(buf)
    return h.digest()


def encode_one(file_id: int, wav_path: str, compression_level: float, subtype: str):
    """
    Encode a single WAV to FLAC, verify the round-trip is bit-identical, and
    return a dict describing the outcome. NEVER raises — converts all errors
    to a `skip` result with a classified reason so one bad file can't abort
    the worker.
    """
    import soundfile as sf
    import numpy as np

    try:
        # Filename sanitization — the wav_path is passed in by the Node caller
        # which has already validated it, but defense-in-depth never hurts.
        wav = Path(wav_path)
        if not wav.is_file():
            return {
                "type": "skip",
                "audio_file_id": file_id,
                "reason": "wav_missing",
            }

        # Idempotency: detect already-FLAC by header (not extension).
        try:
            info = sf.info(str(wav))
        except Exception as exc:  # noqa: BLE001
            return {
                "type": "skip",
                "audio_file_id": file_id,
                "reason": classify_exception(exc),
            }

        if (info.format or "").upper() == "FLAC":
            return {
                "type": "skip",
                "audio_file_id": file_id,
                "reason": "already_flac",
            }

        # Read source — always 2D so stereo files keep both channels.
        try:
            samples, sr = sf.read(str(wav), dtype="int16", always_2d=True)
        except Exception as exc:  # noqa: BLE001
            return {
                "type": "skip",
                "audio_file_id": file_id,
                "reason": classify_exception(exc),
            }

        if samples.shape[0] == 0:
            return {
                "type": "skip",
                "audio_file_id": file_id,
                "reason": "empty_wav",
            }

        tmp = wav.with_suffix(wav.suffix + ".tmp.flac")
        try:
            try:
                sf.write(
                    str(tmp),
                    samples,
                    int(sr),
                    subtype=subtype,
                    format="FLAC",
                    compression_level=float(compression_level),
                )
            except Exception as exc:  # noqa: BLE001
                # Try to clean up partial file
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                return {
                    "type": "skip",
                    "audio_file_id": file_id,
                    "reason": classify_exception(exc),
                }

            # Verify round-trip — three explicit checks, distinct skip reasons.
            try:
                decoded, dec_sr = sf.read(str(tmp), dtype="int16", always_2d=True)
            except Exception as exc:  # noqa: BLE001
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                return {
                    "type": "skip",
                    "audio_file_id": file_id,
                    "reason": classify_exception(exc),
                }

            if decoded.shape != samples.shape:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                return {
                    "type": "skip",
                    "audio_file_id": file_id,
                    "reason": "channel_or_length_mismatch",
                }
            if int(dec_sr) != int(sr):
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                return {
                    "type": "skip",
                    "audio_file_id": file_id,
                    "reason": "sample_rate_mismatch",
                }

            # MD5-of-bytes — same guarantee as np.array_equal, lower peak memory.
            # `.tobytes()` is a contiguous copy; both arrays share dtype int16.
            if _md5_bytes(np.ascontiguousarray(samples).tobytes()) != _md5_bytes(
                np.ascontiguousarray(decoded).tobytes()
            ):
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                return {
                    "type": "skip",
                    "audio_file_id": file_id,
                    "reason": "samples_diverged",
                }

            wav_size = wav.stat().st_size
            flac_size = tmp.stat().st_size

            # If FLAC is no smaller than the WAV (rare — high-entropy noise),
            # surface as a verdict rather than a skip. Node side will mark
            # compressed=true with NULL originalDriveRevisionId (no Drive
            # replacement needed) so we don't re-try every job run.
            if flac_size >= wav_size:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                return {
                    "type": "result",
                    "audio_file_id": file_id,
                    "verdict": "non_compressible",
                    "wav_size": wav_size,
                    "flac_size": flac_size,
                }

            return {
                "type": "result",
                "audio_file_id": file_id,
                "verdict": "compressed",
                "wav_size": wav_size,
                "flac_size": flac_size,
                "flac_path": str(tmp),
            }
        except MemoryError:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            return {
                "type": "skip",
                "audio_file_id": file_id,
                "reason": "oom_during_encode",
            }
    except Exception as exc:  # noqa: BLE001 — defense in depth
        return {
            "type": "skip",
            "audio_file_id": file_id,
            "reason": classify_exception(exc),
        }


def main():
    raw = sys.stdin.readline().strip()
    if not raw:
        emit({"type": "error", "message": "No config received on stdin"})
        sys.exit(1)

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        emit({"type": "error", "message": f"Malformed stdin JSON: {exc}"})
        sys.exit(1)

    files = payload.get("files", [])
    config = payload.get("config", {}) or {}
    compression_level = float(config.get("compression_level", 0.8))
    subtype = str(config.get("subtype", "PCM_16"))
    requested_workers = int(config.get("workers", 3))

    # Surface ImportError clearly so the Node side can fail the job.
    try:
        import soundfile  # noqa: F401
        import numpy  # noqa: F401
    except ImportError as exc:
        emit({"type": "error", "message": f"Required library missing: {exc}"})
        sys.exit(1)

    # Leave one CPU for the Node parent + Drive uploads.
    cpu = os.cpu_count() or 2
    workers = max(1, min(requested_workers, cpu - 1))

    emit({
        "type": "info",
        "message": (
            f"Codificando {len(files)} archivo(s) WAV → FLAC "
            f"(compression_level={compression_level}, workers={workers})"
        ),
    })

    total = len(files)
    processed = 0
    skipped = 0
    start = time.time()

    # Build tasks
    tasks = [
        (f.get("id"), f.get("wav_path"))
        for f in files
        if f.get("id") is not None and f.get("wav_path")
    ]

    if not tasks:
        emit({"type": "complete", "total_processed": 0, "total_skipped": 0})
        return

    # When workers == 1, skip the executor entirely — easier to debug and
    # avoids a measurable startup cost on small batches.
    if workers == 1:
        idx = 0
        for fid, wp in tasks:
            idx += 1
            res = encode_one(fid, wp, compression_level, subtype)
            emit(res)
            if res.get("type") == "result":
                processed += 1
            else:
                skipped += 1
            emit({"type": "progress", "index": idx, "total": total})
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(encode_one, fid, wp, compression_level, subtype): fid
                for fid, wp in tasks
            }
            idx = 0
            for fut in as_completed(futures):
                idx += 1
                try:
                    res = fut.result()
                except Exception as exc:  # noqa: BLE001 — worker crashed
                    res = {
                        "type": "skip",
                        "audio_file_id": futures[fut],
                        "reason": classify_exception(exc),
                    }
                emit(res)
                if res.get("type") == "result":
                    processed += 1
                else:
                    skipped += 1
                emit({"type": "progress", "index": idx, "total": total})

    elapsed = time.time() - start
    emit({
        "type": "info",
        "message": f"Listo en {elapsed:.1f}s — {processed} procesados, {skipped} omitidos",
    })
    emit({
        "type": "complete",
        "total_processed": processed,
        "total_skipped": skipped,
    })


if __name__ == "__main__":
    main()
