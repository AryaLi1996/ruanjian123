#!/usr/bin/env python3
"""Regression guard for the synthesiser's weight initialisation.

`build_stub_model()` and `MicroVITSModel._init_near_identity()` both seed a
near-identity matrix plus symmetry-breaking noise. The noise has to be scaled
by 1/sqrt(hop): each output sample is one row of the matrix dotted with the
frame, so it accumulates hop-1 off-diagonal terms and a flat per-element 0.01
lands at 0.01*sqrt(255) ~ 0.16 — 16% of the signal, not 1%.

Unscaled, this graph reproduced a pure tone at 12.3 dB SNR: audible broadband
hash on everything the synthesiser produced, and standard-mode training only
adapts 2048 LoRA parameters on layer1 so it could never train that out. These
checks pin the scaling, the float32 dtype (a float64 scale promotes the
weights and ONNX rejects the graph), and that both initialisers agree.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import onnx
from onnx import numpy_helper

from synthesizer import SAMPLE_RATE, Synthesizer, build_stub_model
from trainer import MicroVITSModel

results = []


def check(name, condition, detail=""):
    results.append(bool(condition))
    print(f"[{'PASS' if condition else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def row_perturbation(W):
    """How much of a random mix of the other samples each output sample gets."""
    off = W - np.diag(np.diag(W))
    return float(np.sqrt((off ** 2).sum(axis=1)).mean())


# ── The freshly built graph ───────────────────────────────────────────────────
graph = onnx.load_from_string(build_stub_model())
weights = {i.name: numpy_helper.to_array(i) for i in graph.graph.initializer}

for name in ("W1", "W2"):
    W = weights[name]
    check(f"{name} is float32", W.dtype == np.float32, str(W.dtype))
    pert = row_perturbation(W)
    # 0.01 is the documented intent; the unscaled bug sat at 0.159.
    check(f"{name} perturbs each output sample by ~1%, not ~16%",
          0.005 < pert < 0.02, f"{pert:.5f} per row")

# ── The committed model file must carry the fix too ───────────────────────────
# ensure_model() only builds a stub when the file is missing, so a corrected
# builder does nothing for a checkout that already has the old file.
committed = onnx.load(str(Path(__file__).parent / "model.onnx"))
cw = {i.name: numpy_helper.to_array(i) for i in committed.graph.initializer}
check("the committed model.onnx was regenerated, not left stale",
      row_perturbation(cw["W1"]) < 0.02, f"{row_perturbation(cw['W1']):.5f} per row")

# ── End to end: a pure tone in, a pure tone out ───────────────────────────────
audio = np.array(Synthesizer("model.onnx").synthesize(["a"] * 6, [220.0] * 6, [0.5] * 6)["audio"])
N = 1 << 15
centre = len(audio) // 2
seg = audio[centre - N // 2: centre + N // 2].astype(np.float64) * np.hanning(N)
power = np.abs(np.fft.rfft(seg)) ** 2
tone = np.zeros_like(power, dtype=bool)
for h in range(1, 12):
    b = round(220.0 * h * N / SAMPLE_RATE)
    tone[max(0, b - 4): b + 5] = True
snr = 10 * np.log10(power[tone].sum() / max(power[~tone].sum(), 1e-20))
check("synthesising a pure tone is not swamped by broadband noise", snr > 25.0,
      f"{snr:.1f} dB (was 12.3 dB unscaled)")

# ── The two initialisers must not drift apart ─────────────────────────────────
model = MicroVITSModel()
for attr, name in (("layer1", "W1"), ("layer2", "W2")):
    w = getattr(model, attr).weight.detach().numpy()
    diff = float(np.max(np.abs(w - weights[name])))
    check(f"trainer's {attr} matches the stub's {name}", diff < 1e-6, f"max diff {diff:.2e}")

passed = sum(1 for r in results if r)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
