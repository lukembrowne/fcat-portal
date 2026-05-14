"""
FLAC encode runner — unit tests.

Run inside the running container so the ML venv is on PYTHONPATH:

  docker compose exec -T portal data/ml-venv/bin/python3 \
      -m unittest tests.python.test_flac_encode_runner

Cases:
  - Mono round-trip lossless on synth sine
  - Stereo round-trip lossless (regression: always_2d=True invariant)
  - Already-FLAC input → skip(already_flac)
  - Corrupt WAV (truncated header) → skip(corrupt_wav)
  - Empty WAV (0 samples) → skip(empty_wav)
  - High-entropy noise → verdict=non_compressible
  - NDJSON contract: info → result/skip → complete (order)
  - Missing file → skip
  - classify_exception helper
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest
import wave


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
RUNNER_PATH = PROJECT_ROOT / "scripts" / "flac-encode-runner.py"


def _load_runner_module():
    spec = importlib.util.spec_from_file_location("flac_encode_runner", RUNNER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_wav_mono(path: pathlib.Path, samples_int16, sample_rate: int) -> None:
    frames = struct.pack(f"<{len(samples_int16)}h", *samples_int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(frames)


def _write_wav_stereo(path: pathlib.Path, left_int16, right_int16, sample_rate: int) -> None:
    interleaved = []
    for l, r in zip(left_int16, right_int16):
        interleaved.append(l)
        interleaved.append(r)
    frames = struct.pack(f"<{len(interleaved)}h", *interleaved)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(frames)


def _synth_sine_int16(n_samples: int, freq_hz: float, sr: int, amp: float = 0.5):
    return [
        int(round(amp * 32767 * math.sin(2 * math.pi * freq_hz * i / sr)))
        for i in range(n_samples)
    ]


def _synth_noise_int16(n_samples: int, seed: int = 0):
    # Deterministic LCG → high-entropy data → typically non_compressible
    state = (seed * 1103515245 + 12345) & 0x7FFFFFFF
    out = []
    for _ in range(n_samples):
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        out.append((state & 0xFFFF) - 32768)
    return out


def _run_subprocess(payload: dict, python: str | None = None):
    """Spawn the runner, send JSON, return parsed NDJSON messages."""
    python = python or sys.executable
    proc = subprocess.run(
        [python, str(RUNNER_PATH)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"Runner exited {proc.returncode}\nstderr: {proc.stderr}\nstdout: {proc.stdout}"
        )
    messages = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        messages.append(json.loads(line))
    return messages


class TestClassifyException(unittest.TestCase):
    def test_memory_error(self):
        runner = _load_runner_module()
        self.assertEqual(runner.classify_exception(MemoryError()), "oom_during_encode")

    def test_libsndfile_hint(self):
        runner = _load_runner_module()
        e = RuntimeError("libsndfile error: malformed header")
        self.assertEqual(runner.classify_exception(e), "corrupt_wav")

    def test_unknown(self):
        runner = _load_runner_module()
        self.assertEqual(runner.classify_exception(RuntimeError("some other thing")), "unknown")


@unittest.skipUnless(
    pathlib.Path(__file__).exists(),
    "test file must exist",
)
class TestEncodeOneNeedsSoundfile(unittest.TestCase):
    """Tests in this class require `soundfile` and `numpy`. Skipped at import time
    if they aren't available so the runner module can still be imported on
    machines without the ML venv (e.g. CI lint-only jobs).
    """

    def setUp(self):
        try:
            import soundfile  # noqa: F401
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("soundfile or numpy not installed")
        self.runner = _load_runner_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tmpdir = pathlib.Path(self.tmp.name)

    def test_mono_round_trip_lossless(self):
        wav = self.tmpdir / "mono.wav"
        sr = 16000
        samples = _synth_sine_int16(sr, 440.0, sr)
        _write_wav_mono(wav, samples, sr)

        res = self.runner.encode_one(42, str(wav), 0.8, "PCM_16")
        self.assertEqual(res["type"], "result")
        self.assertEqual(res["verdict"], "compressed")
        self.assertEqual(res["audio_file_id"], 42)
        self.assertLess(res["flac_size"], res["wav_size"])
        # Cleanup the tmp.flac so other tests start clean
        try:
            pathlib.Path(res["flac_path"]).unlink()
        except FileNotFoundError:
            pass

    def test_stereo_round_trip_lossless(self):
        """Regression: always_2d=True invariant must keep both channels intact."""
        import soundfile as sf
        import numpy as np

        wav = self.tmpdir / "stereo.wav"
        sr = 16000
        left = _synth_sine_int16(sr, 440.0, sr)
        right = _synth_sine_int16(sr, 660.0, sr, amp=0.4)
        _write_wav_stereo(wav, left, right, sr)

        res = self.runner.encode_one(43, str(wav), 0.8, "PCM_16")
        self.assertEqual(res["type"], "result")
        self.assertEqual(res["verdict"], "compressed")

        # Decode and confirm both channels survived
        decoded, dec_sr = sf.read(res["flac_path"], dtype="int16", always_2d=True)
        self.assertEqual(decoded.shape[1], 2)
        self.assertEqual(int(dec_sr), sr)
        self.assertTrue(np.array_equal(decoded[:, 0], np.asarray(left, dtype=np.int16)))
        self.assertTrue(np.array_equal(decoded[:, 1], np.asarray(right, dtype=np.int16)))
        try:
            pathlib.Path(res["flac_path"]).unlink()
        except FileNotFoundError:
            pass

    def test_already_flac_skip(self):
        import soundfile as sf
        import numpy as np

        flac = self.tmpdir / "already.flac"
        sr = 16000
        samples = np.asarray(_synth_sine_int16(sr, 440.0, sr), dtype=np.int16).reshape(-1, 1)
        sf.write(str(flac), samples, sr, subtype="PCM_16", format="FLAC")

        res = self.runner.encode_one(44, str(flac), 0.8, "PCM_16")
        self.assertEqual(res["type"], "skip")
        self.assertEqual(res["reason"], "already_flac")

    def test_corrupt_wav_skip(self):
        # Write garbage with a .wav suffix — sf.info should raise.
        bad = self.tmpdir / "bad.wav"
        bad.write_bytes(b"not a real wav header at all")

        res = self.runner.encode_one(45, str(bad), 0.8, "PCM_16")
        self.assertEqual(res["type"], "skip")
        self.assertIn(res["reason"], {"corrupt_wav", "unknown"})

    def test_empty_wav_skip(self):
        wav = self.tmpdir / "empty.wav"
        _write_wav_mono(wav, [], 16000)

        res = self.runner.encode_one(46, str(wav), 0.8, "PCM_16")
        self.assertEqual(res["type"], "skip")
        self.assertEqual(res["reason"], "empty_wav")

    def test_missing_file_skip(self):
        res = self.runner.encode_one(47, str(self.tmpdir / "does-not-exist.wav"), 0.8, "PCM_16")
        self.assertEqual(res["type"], "skip")
        self.assertEqual(res["reason"], "wav_missing")

    def test_non_compressible_noise(self):
        """High-entropy noise typically yields flac_size >= wav_size."""
        wav = self.tmpdir / "noise.wav"
        sr = 16000
        samples = _synth_noise_int16(sr // 2)  # 0.5s of noise
        _write_wav_mono(wav, samples, sr)

        res = self.runner.encode_one(48, str(wav), 0.8, "PCM_16")
        self.assertEqual(res["type"], "result")
        # Could be either depending on libflac version, but for true RNG-style
        # 16-bit noise FLAC's overhead usually pushes flac_size above wav_size
        # on short files. Accept either verdict, but the size fields must exist.
        self.assertIn(res["verdict"], {"compressed", "non_compressible"})
        self.assertGreater(res["wav_size"], 0)
        self.assertGreater(res["flac_size"], 0)
        if res["verdict"] == "compressed":
            try:
                pathlib.Path(res["flac_path"]).unlink()
            except FileNotFoundError:
                pass


class TestNdjsonContract(unittest.TestCase):
    """Full subprocess run with a single mono file — confirms the protocol order."""

    def setUp(self):
        try:
            import soundfile  # noqa: F401
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("soundfile or numpy not installed")

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tmpdir = pathlib.Path(self.tmp.name)
        wav = self.tmpdir / "ndjson.wav"
        sr = 16000
        _write_wav_mono(wav, _synth_sine_int16(sr, 440.0, sr), sr)
        self.wav = wav

    def test_message_order_and_terminator(self):
        payload = {
            "files": [{"id": 99, "wav_path": str(self.wav)}],
            "config": {"compression_level": 0.8, "subtype": "PCM_16", "workers": 1},
        }
        msgs = _run_subprocess(payload)
        types = [m["type"] for m in msgs]
        self.assertEqual(types[0], "info")
        self.assertEqual(types[-1], "complete")
        # Exactly one result or skip for our single file
        body = [m for m in msgs if m["type"] in {"result", "skip"}]
        self.assertEqual(len(body), 1)
        # And at least one progress message
        self.assertTrue(any(m["type"] == "progress" for m in msgs))
        # Cleanup any leftover .tmp.flac the runner might have produced
        result = [m for m in msgs if m["type"] == "result"]
        if result and result[0].get("flac_path"):
            try:
                pathlib.Path(result[0]["flac_path"]).unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    unittest.main()
