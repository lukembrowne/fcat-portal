"""
Acoustic-indices Python runner — unit tests.

Run inside the running container so the ML venv is on PYTHONPATH:

  docker compose exec -T portal data/ml-venv/bin/python3 \
      -m unittest tests.python.test_acoustic_indices_runner

(Locally, install scikit-maad + scipy into the ml-venv first and use the
same command without `docker compose exec`.)

Tests:
  - headline synthetic-bursts fixture (eps, ss, aci within tolerances)
  - all-silent → SS = 0, EPS = 0
  - white-noise burst → high SS
  - corrupt header → skipped with structured reason
  - too-short → skipped with structured reason
  - missing file → skipped with structured reason
  - parse_recording_hour + assign_diel_period helpers
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
RUNNER_PATH = PROJECT_ROOT / "scripts" / "acoustic-indices-runner.py"


def _load_runner_module():
    """Import scripts/acoustic-indices-runner.py as a module so we can call
    helper functions directly without spawning a subprocess."""
    spec = importlib.util.spec_from_file_location("acoustic_indices_runner", RUNNER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_wav(path: pathlib.Path, samples, sample_rate: int) -> None:
    """Write a mono float32 array as a 16-bit PCM WAV (stdlib only)."""
    import struct
    import wave

    n = len(samples)
    # Scale floats in [-1, 1] to int16
    int_samples = [max(-32768, min(32767, int(round(v * 32767)))) for v in samples]
    frames = struct.pack(f"<{n}h", *int_samples)

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(frames)


def _make_burst_fixture(path: pathlib.Path, sr: int = 44100) -> None:
    """60 s mono WAV with three 200 ms tonal bursts at 2, 4, 8 kHz."""
    import math

    duration = 60.0
    n_total = int(sr * duration)
    samples = [0.0] * n_total

    bursts = [
        (2000, 5.0),   # 2 kHz at 5 s
        (4000, 20.0),  # 4 kHz at 20 s
        (8000, 40.0),  # 8 kHz at 40 s
    ]
    burst_len_s = 0.2
    burst_len = int(sr * burst_len_s)

    for freq, start_s in bursts:
        start = int(sr * start_s)
        for i in range(burst_len):
            samples[start + i] = 0.6 * math.sin(2 * math.pi * freq * (i / sr))

    _write_wav(path, samples, sr)


def _make_silent_fixture(path: pathlib.Path, sr: int = 44100, seconds: float = 60.0) -> None:
    _write_wav(path, [0.0] * int(sr * seconds), sr)


def _make_white_noise_fixture(path: pathlib.Path, sr: int = 44100, seconds: float = 60.0) -> None:
    import random
    random.seed(42)
    samples = [random.uniform(-0.4, 0.4) for _ in range(int(sr * seconds))]
    _write_wav(path, samples, sr)


def _make_short_fixture(path: pathlib.Path, sr: int = 44100) -> None:
    _write_wav(path, [0.0] * (sr * 5), sr)  # 5 s — under the 30 s floor


def _make_corrupt_fixture(path: pathlib.Path) -> None:
    path.write_bytes(b"NOT A WAV FILE - \x00\x01\x02 garbage")


CONFIG = {
    "targetSampleRate": 44100,
    "windowSeconds": 60,
    "freqLowHz": 50,
    "freqHighHz": 8000,
    "ssThresholdDb": 9,
    "epsMinEventSeconds": 0.06,
}


class HelperTests(unittest.TestCase):
    """Pure-Python helpers — no audio deps needed."""

    @classmethod
    def setUpClass(cls):
        cls.mod = _load_runner_module()

    def test_parse_recording_hour_canonical_name(self):
        date, hour = self.mod.parse_recording_hour("2MM21799_20260119_183500.wav")
        self.assertEqual(date, "2026-01-19")
        self.assertEqual(hour, 18)

    def test_parse_recording_hour_unparseable(self):
        date, hour = self.mod.parse_recording_hour("garbage.wav")
        self.assertIsNone(date)
        self.assertIsNone(hour)

    def test_assign_diel_period_simple_range(self):
        ranges = {"dawn": (5, 7), "midday": (11, 13), "dusk": (17, 19), "night": (22, 4)}
        self.assertEqual(self.mod.assign_diel_period(5, ranges), "dawn")
        self.assertEqual(self.mod.assign_diel_period(6, ranges), "dawn")
        self.assertEqual(self.mod.assign_diel_period(12, ranges), "midday")
        self.assertEqual(self.mod.assign_diel_period(18, ranges), "dusk")

    def test_assign_diel_period_night_wraps_midnight(self):
        ranges = {"night": (22, 4)}
        self.assertEqual(self.mod.assign_diel_period(22, ranges), "night")
        self.assertEqual(self.mod.assign_diel_period(23, ranges), "night")
        self.assertEqual(self.mod.assign_diel_period(0, ranges), "night")
        self.assertEqual(self.mod.assign_diel_period(3, ranges), "night")
        self.assertEqual(self.mod.assign_diel_period(4, ranges), "other")  # exclusive end
        self.assertEqual(self.mod.assign_diel_period(10, ranges), "other")

    def test_assign_diel_period_none_hour(self):
        self.assertEqual(self.mod.assign_diel_period(None, {"dawn": (5, 7)}), "other")

    def test_config_hash_is_deterministic_and_version_sensitive(self):
        h1 = self.mod.compute_config_hash(CONFIG, "1.0", "1.4.0")
        h2 = self.mod.compute_config_hash(CONFIG, "1.0", "1.4.0")
        h3 = self.mod.compute_config_hash(CONFIG, "1.1", "1.4.0")
        h4 = self.mod.compute_config_hash(CONFIG, "1.0", "9.9.9")
        self.assertEqual(h1, h2)
        self.assertNotEqual(h1, h3)
        self.assertNotEqual(h1, h4)
        self.assertTrue(h1.startswith("sha256:"))


def _have_audio_deps() -> bool:
    return all(
        importlib.util.find_spec(name) is not None
        for name in ("numpy", "scipy", "librosa", "maad")
    )


@unittest.skipUnless(_have_audio_deps(), "audio deps (numpy/scipy/librosa/maad) not in this venv")
class ComputeTests(unittest.TestCase):
    """End-to-end compute over synthetic fixtures. Needs the ML venv."""

    @classmethod
    def setUpClass(cls):
        cls.mod = _load_runner_module()
        cls.tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="acoustic-indices-test-"))
        cls.burst_path = cls.tmpdir / "burst_20260119_183500.wav"
        cls.silent_path = cls.tmpdir / "silent_20260119_183500.wav"
        cls.noise_path = cls.tmpdir / "noise_20260119_183500.wav"
        _make_burst_fixture(cls.burst_path)
        _make_silent_fixture(cls.silent_path)
        _make_white_noise_fixture(cls.noise_path)
        import maad
        from maad import sound as maad_alpha
        from maad import features as maad_features
        cls.maad_alpha = maad_alpha
        cls.maad_features = maad_features

    def _compute(self, path):
        return self.mod.compute_indices(
            str(path), CONFIG, self.maad_alpha, self.maad_features
        )

    def test_burst_fixture_headline(self):
        result = self._compute(self.burst_path)
        # 3 events in 60 s → ~0.05 EPS. ±50% tolerance keeps the test stable
        # across small algorithm changes; the *direction* matters more here.
        self.assertGreater(result["events_per_second"], 0.02)
        self.assertLess(result["events_per_second"], 0.20)
        # 3 bursts each occupy a narrow band → very low SS but > 0
        self.assertGreater(result["soundscape_saturation"], 0.0)
        self.assertLess(result["soundscape_saturation"], 0.10)
        # ACI is non-zero and finite
        self.assertGreater(result["acoustic_complexity_index"], 0)
        self.assertTrue(0 <= result["frequency_entropy"] <= 1.0001)
        self.assertTrue(0 <= result["temporal_entropy"] <= 1.0001)

    def test_silent_fixture_zero_ss_zero_eps(self):
        result = self._compute(self.silent_path)
        # Silent → no signal above background → SS ≈ 0, EPS ≈ 0
        self.assertAlmostEqual(result["soundscape_saturation"], 0.0, places=2)
        self.assertAlmostEqual(result["events_per_second"], 0.0, places=2)

    def test_white_noise_fixture_high_ss(self):
        result = self._compute(self.noise_path)
        # Broadband noise fills the spectrum → SS should be high (>0.5).
        self.assertGreater(result["soundscape_saturation"], 0.5)

    def test_too_short_raises(self):
        short = self.tmpdir / "short.wav"
        _make_short_fixture(short)
        with self.assertRaises(ValueError) as ctx:
            self._compute(short)
        self.assertIn("30", str(ctx.exception))  # mentions the 30 s floor

    def test_corrupt_raises(self):
        corrupt = self.tmpdir / "corrupt.wav"
        _make_corrupt_fixture(corrupt)
        with self.assertRaises(Exception):
            self._compute(corrupt)


@unittest.skipUnless(_have_audio_deps(), "audio deps not in this venv")
class SubprocessTests(unittest.TestCase):
    """Drive the runner over its real stdin/stdout NDJSON contract."""

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="acoustic-indices-sub-"))
        cls.burst = cls.tmpdir / "fixture_20260119_183500.wav"
        _make_burst_fixture(cls.burst)
        cls.missing = cls.tmpdir / "does_not_exist_20260119_183500.wav"

    def test_runner_emits_expected_messages(self):
        payload = {
            "files": [
                {"id": 1, "path": str(self.burst), "filename": self.burst.name},
                {"id": 2, "path": str(self.missing), "filename": self.missing.name},
            ],
            "config": CONFIG,
            "config_version": "1.0",
            "diel_periods": ["dawn", "midday", "dusk", "night", "other"],
            "diel_period_ranges": {
                "dawn": [5, 7], "midday": [11, 13],
                "dusk": [17, 19], "night": [22, 4],
            },
        }

        proc = subprocess.run(
            [sys.executable, str(RUNNER_PATH)],
            input=json.dumps(payload) + "\n",
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(proc.returncode, 0, msg=f"stderr: {proc.stderr}")

        messages = [json.loads(line) for line in proc.stdout.strip().splitlines() if line.strip()]
        types = [m["type"] for m in messages]
        self.assertIn("info", types)
        self.assertIn("result", types)
        self.assertIn("skip", types)
        self.assertIn("complete", types)

        # The result row carries the right diel_period and config_hash shape.
        results = [m for m in messages if m["type"] == "result"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["audio_file_id"], 1)
        self.assertEqual(results[0]["diel_period"], "dusk")  # hour=18 falls in [17, 19)
        self.assertTrue(results[0]["config_hash"].startswith("sha256:"))

        complete = [m for m in messages if m["type"] == "complete"][0]
        self.assertEqual(complete["total_processed"], 1)
        self.assertEqual(complete["total_skipped"], 1)


if __name__ == "__main__":
    unittest.main()
