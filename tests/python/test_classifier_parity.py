"""Cross-repo preprocessing parity for the custom classifier.

The classifier repo (fcat-biochoco-camera-classifier) emits a parity fixture via
``experiments/make_parity_fixture.py``: a fixed crop, the exact tensor after its
v3 transform, and the transform recipe. This test asserts the PORTAL's inference
preprocessing (``model-server._build_eval_transform``) reproduces that tensor
byte-for-byte from the same crop.

This is the high-value, version-robust half of round-trip parity: the most likely
portal regression is a wrong resize/interpolation/mean/std. Reconstruction-logit
parity on the real ViT-H is a separate one-time check on the prod box (it needs
the 2.5 GB hub download), per the Phase 2 plan.

Run inside the ML venv (has torch/torchvision/numpy/Pillow):

  data/ml-venv/bin/python3 -m unittest tests.python.test_classifier_parity
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import unittest

import numpy as np
from PIL import Image

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
SERVER_PATH = PROJECT_ROOT / "scripts" / "model-server.py"
FIXTURE_DIR = pathlib.Path(__file__).resolve().parent / "fixtures" / "parity"


def _load_server_module():
    """Import scripts/model-server.py as a module (top level is stdlib-only)."""
    spec = importlib.util.spec_from_file_location("model_server", SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ClassifierParityTest(unittest.TestCase):
    def test_portal_transform_matches_trainer(self):
        module = _load_server_module()
        ref = json.loads((FIXTURE_DIR / "reference.json").read_text())
        expected = np.load(FIXTURE_DIR / "preprocessed.npy")

        # The portal transform consumes a numpy crop (HWC uint8), exactly as it
        # receives MegaDetector crops; the trainer fed a PIL image. Both must
        # land on the same normalized tensor.
        crop = np.array(Image.open(FIXTURE_DIR / "crop.png").convert("RGB"))
        transform = module._build_eval_transform(ref["transform"])
        out = transform(crop).numpy()

        self.assertEqual(list(out.shape), ref["preprocessedShape"])
        atol = ref.get("tolerance", {}).get("preprocessed_atol", 1e-5)
        np.testing.assert_allclose(out, expected, atol=atol)


if __name__ == "__main__":
    unittest.main()
