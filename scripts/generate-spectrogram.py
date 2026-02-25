#!/usr/bin/env python3
"""
Generate a mel spectrogram PNG from an audio file.

Usage: python generate-spectrogram.py <input.wav> <output.png>
Outputs JSON metadata to stdout.
"""

import sys
import json
import librosa
import numpy as np
from PIL import Image

# Attempt to use matplotlib colormap for magma
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.cm as cm
    CMAP = cm.get_cmap("magma")
except Exception:
    CMAP = None

SR = 48000
N_FFT = 2048
HOP = 512
N_MELS = 128
FMIN = 200.0
FMAX = 12000.0
HEIGHT = 512


def magma_fallback(values):
    """Simple magma-like colormap fallback if matplotlib unavailable."""
    # Grayscale fallback
    v = (values * 255).astype(np.uint8)
    return np.stack([v, v, v], axis=-1)


def main(wav_path, output_path):
    y, sr = librosa.load(wav_path, sr=SR, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)

    S = librosa.feature.melspectrogram(
        y=y, sr=sr, n_fft=N_FFT, hop_length=HOP,
        n_mels=N_MELS, fmin=FMIN, fmax=FMAX, power=2.0
    )
    S_dB = librosa.power_to_db(S, ref=np.max)

    # Normalize to 0-1
    s_min, s_max = S_dB.min(), S_dB.max()
    S_norm = (S_dB - s_min) / (s_max - s_min + 1e-10)

    # Apply colormap
    if CMAP is not None:
        S_rgb = (CMAP(S_norm)[:, :, :3] * 255).astype(np.uint8)
    else:
        S_rgb = magma_fallback(S_norm)

    # Flip so low frequencies are at bottom
    S_rgb = np.flipud(S_rgb)

    img = Image.fromarray(S_rgb, "RGB")

    # Resize to fixed height, width proportional to duration
    aspect = img.width / img.height
    new_w = int(HEIGHT * aspect)
    img = img.resize((new_w, HEIGHT), Image.LANCZOS)
    img.save(output_path, "PNG", optimize=True)

    # Output metadata as JSON
    meta = {
        "duration": round(duration, 3),
        "sampleRate": int(sr),
        "width": new_w,
        "height": HEIGHT,
        "pixelsPerSecond": round(new_w / duration, 2) if duration > 0 else 0,
        "hzPerPixel": round((FMAX - FMIN) / HEIGHT, 2),
        "fmin": FMIN,
        "fmax": FMAX,
        "nFft": N_FFT,
        "hopLength": HOP,
        "nMels": N_MELS,
    }
    print(json.dumps(meta))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python generate-spectrogram.py <input> <output.png>", file=sys.stderr)
        sys.exit(1)
    try:
        main(sys.argv[1], sys.argv[2])
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
