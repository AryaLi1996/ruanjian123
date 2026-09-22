#!/usr/bin/env python3
"""Regression guard for the learned per-frame timbre decoder.

The bug this exists to stop coming back: training used to optimise
``target = frames`` — reproduce your own input — against weights initialised
to 0.98 x identity. The initialisation already solved it, so 30 epochs moved
the loss 2.2e-05 -> 1.9e-05 and none of that was about the singer. Thirty
minutes of training changed nothing audible, and a GPU would only have
reached the same nothing faster.

The fix is not a bigger model, it is a task with an answer that is not in the
question: take the singer's spectral envelope *off* the input and make it the
target. These checks pin that property first, because every other claim here
depends on it.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np

import voice_model as vm

results = []


def check(name, condition, detail=""):
    results.append(bool(condition))
    print(f"[{'PASS' if condition else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


# ── fixture: two voices differing only by a smooth vocal-tract response ──────

_HZ = np.array([0, 150, 300, 500, 800, 1200, 2000, 3200, 5000, 8000, 11025.])
DARK = np.array([0, 4, 8, 10, 6, 0, -6, -12, -16, -20, -24.])
BRIGHT = np.array([0, -8, -6, -2, 2, 6, 9, 8, 5, 2, 0.])


def _excitation(n, seed, base):
    rng = np.random.default_rng(seed)
    t = np.arange(n) / vm.SR
    notes = np.array([1.0, 1.122, 1.189, 1.335, 1.498, 1.335, 1.189, 1.0]) * base
    f0 = np.zeros(n)
    seg = n // len(notes)
    for i, f in enumerate(notes):
        f0[i * seg:(i + 1) * seg] = f
    f0[len(notes) * seg:] = notes[-1]
    f0 *= 1 + 0.005 * np.sin(2 * np.pi * 5.1 * t)
    ph = 2 * np.pi * np.cumsum(f0) / vm.SR
    x = sum((1.0 / k) * np.sin(k * ph + 0.4 * k) for k in range(1, 45))
    for c in np.linspace(0.3, n / vm.SR - 0.3, int(n / vm.SR * 2)):
        i0, w = int(c * vm.SR), int(0.012 * vm.SR)
        if i0 + w < n:
            x[i0:i0 + w] += 0.30 * np.max(np.abs(x)) * rng.standard_normal(w) * np.hanning(w)
    gate = np.ones(n)
    for lo, hi in [(.12, .18), (.42, .48), (.72, .78)]:
        gate[int(lo * n):int(hi * n)] = 0.0
    k = np.hanning(1024) / np.sum(np.hanning(1024))
    return x * np.convolve(gate, k, mode="same")


def singer(seconds, seed, curve, base=200.0):
    n = int(vm.SR * seconds)
    spec = vm.stft(_excitation(n, seed, base))
    hz = np.linspace(0.0, vm.SR / 2.0, spec.shape[0])
    gain = 10.0 ** (np.interp(hz, _HZ, curve) / 20.0)
    y = vm.istft(spec * gain[:, None], n)
    return (y * 0.5 / (np.max(np.abs(y)) + 1e-9)).astype(np.float32)


# ── the property the whole change rests on ───────────────────────────────────

audio = singer(6.0, 10, DARK, 196.0)
content = vm.content_features(audio)
target = vm.target_envelope(audio)

check("content and target line up frame for frame",
      content.shape[1] == target.shape[1]
      and content.shape[0] == vm.N_CONTENT and target.shape[0] == vm.N_MEL,
      f"content {content.shape}, target {target.shape}")

# The old objective was target == input. If that ever comes back, a linear
# read-out of the content would reconstruct the target exactly. Fit the map
# on one half and score it on the other: fitting and scoring on the same
# frames says 97% for any 82-in/80-out map with enough frames, which measures
# the fit's freedom rather than the task's difficulty.
half = content.shape[1] // 2
A = np.linalg.lstsq(content[:, :half].T, target[:, :half].T, rcond=None)[0]
held = target[:, half:].T
resid = held - content[:, half:].T @ A
explained = 1.0 - float((resid ** 2).sum() / ((held - held.mean(0)) ** 2).sum())
check("the target is not readable straight off the input",
      explained < 0.95,
      f"a linear map fitted on the first half explains {100 * explained:.0f}% "
      f"of the second (the old target = input objective would be 100%)")

# Belt and braces: the timbre really is absent from the content, i.e. two
# singers sharing an excitation produce near-identical content.
dark = singer(6.0, 10, DARK, 196.0)
bright_same_source = vm.istft(
    vm.stft(_excitation(int(vm.SR * 6.0), 10, 196.0))
    * (10.0 ** (np.interp(np.linspace(0, vm.SR / 2, vm.N_FFT // 2 + 1), _HZ, BRIGHT) / 20.0))[:, None],
    int(vm.SR * 6.0))
c_dark = vm.content_features(dark)
c_bright = vm.content_features(bright_same_source)
t_dark = vm.target_envelope(dark)
t_bright = vm.target_envelope(bright_same_source)
content_gap = float(np.abs(c_dark[:vm.N_MEL] - c_bright[:vm.N_MEL]).mean())
target_gap = float(np.abs(t_dark - t_bright).mean())
check("changing only the timbre moves the target far more than the content",
      target_gap > 3.0 * content_gap,
      f"content moves {content_gap:.3f}, target moves {target_gap:.3f} "
      f"({target_gap / max(content_gap, 1e-9):.1f}x)")


# ── the model, and that training on this task actually converges ─────────────

try:
    import torch
    import torch.nn as nn

    torch.manual_seed(0)
    model = vm.build_torch_decoder()
    n_params = sum(p.numel() for p in model.parameters())
    check("the decoder has capacity to learn a vocal tract",
          n_params > 100_000, f"{n_params:,} parameters")

    ct = torch.tensor(content, dtype=torch.float32)[None]
    tt = torch.tensor(target, dtype=torch.float32)[None]
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    first = last = None
    for step in range(200):
        opt.zero_grad()
        loss = nn.functional.l1_loss(model(ct), tt)
        loss.backward()
        opt.step()
        if step == 0:
            first = loss.item()
        last = loss.item()
    check("training moves the loss by more than the old objective ever did",
          last < first * 0.5,
          f"{first:.4f} -> {last:.4f} ({100 * (1 - last / first):.0f}%; "
          f"the old objective managed 13% over 30 epochs)")

    # numpy inference has to agree with the module it is trained as, or the
    # exported model is not the model that was trained.
    weights = vm.decoder_state_to_arrays(model)
    with torch.no_grad():
        reference = model(ct)[0].numpy()
    err = float(np.max(np.abs(vm.predict_envelope(weights, content) - reference)))
    # float32 precision, not an approximation budget: _gelu is exact erf. The
    # tanh shortcut sat at 1.7e-03 here, which is inaudible but is still the
    # exported model not being the model that was trained.
    check("numpy inference matches the trained torch module",
          err < 1e-4, f"max abs error {err:.2e}")

except ImportError:
    print("[SKIP] torch not available — training checks skipped")


# ── resynthesis keeps what it is supposed to keep ────────────────────────────

flat = {f"{vm.WEIGHT_PREFIX}{i}.{w}": (
    np.zeros((vm.N_MEL if i == 4 else vm.HIDDEN_STANDARD,
              vm.HIDDEN_STANDARD if i else vm.N_CONTENT,
              1 if i == 4 else vm.KERNEL), dtype=np.float32) if w == "weight"
    else np.zeros(vm.N_MEL if i == 4 else vm.HIDDEN_STANDARD, dtype=np.float32))
    for i in (0, 2, 4) for w in ("weight", "bias")}

# An all-zero decoder does not mean "no change" — it predicts a flat
# envelope, which is a real (if useless) timbre. What must hold is that the
# result stays finite and bounded: the conversion divides by the source
# envelope, and an unbounded ratio there would be audible as a blow-up.
zeroed = vm.convert(audio, flat)
check("a degenerate decoder produces bounded audio rather than a blow-up",
      np.isfinite(zeroed).all() and float(np.max(np.abs(zeroed))) < 4.0,
      f"peak {float(np.max(np.abs(zeroed))):.2f}")

check("strength 0 returns the reference unchanged",
      np.allclose(vm.convert(audio, flat, strength=0.0), audio, atol=2e-3))

check("audio shorter than one frame is passed through, not crashed on",
      vm.convert(audio[:100], flat).shape == (100,))


# ── the mel -> linear mapping is by frequency, the PR #102 lesson ────────────

peak = np.full((vm.N_MEL, 1), -2.0)
band = int(np.argmin(np.abs(vm.MEL_HZ - 700.0)))
peak[band, 0] = 4.0
wide = vm.mel_envelope_to_linear(peak, 1025, 44_100)
landed = float(np.argmax(wide[:, 0])) * (44_100 / 2) / 1024
check("an envelope learned at 22.05 kHz lands on the right Hz at 44.1 kHz",
      abs(landed - vm.MEL_HZ[band]) < 60.0,
      f"a {vm.MEL_HZ[band]:.0f} Hz band landed at {landed:.0f} Hz "
      f"(bin-index interpolation would put it near {vm.MEL_HZ[band] * 2:.0f} Hz)")

check("the frame rate matches the cover's, so no retiming is needed",
      abs(vm.SR / vm.HOP - 44_100 / 512) < 1e-6,
      f"{vm.SR / vm.HOP:.2f} fps both sides")


# ── the fallback chain: never invent a voice you were not given ──────────────

from cover_synthesis import _load_decoder  # noqa: E402

import tempfile  # noqa: E402

import trainer  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "stub.onnx"
    trainer.export_to_onnx(trainer.MicroVITSModel(), path)
    check("a model with no decoder reads back as None", _load_decoder(path) is None)

    try:
        import torch  # noqa: F811
        trainer.export_to_onnx(trainer.MicroVITSModel(), path,
                               extra_arrays=vm.decoder_state_to_arrays(vm.build_torch_decoder()))
        loaded = _load_decoder(path)
        check("a trained decoder survives the ONNX round-trip",
              loaded is not None and len(loaded) == 6)
    except ImportError:
        pass

# ── the gate: a decoder only ships when it beat the envelope it replaces ────

try:
    import torch  # noqa: F811

    import soundfile as sf  # noqa: E402

    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "raw"
        src.mkdir()
        sf.write(str(src / "a.wav"), singer(8.0, 10, DARK, 196.0), vm.SR)

        env = trainer._learn_timbre(src)
        untrained = vm.build_torch_decoder()
        # An untrained decoder outputs near-zero — a flat timbre — which is a
        # worse description of this singer than their own average envelope.
        check("an untrained decoder loses to the average envelope",
              not trainer._decoder_beats_envelope(untrained, src, env, "cpu"))

        # With nothing to fall back to, the decoder is all there is.
        check("with no envelope to fall back to the decoder is kept anyway",
              trainer._decoder_beats_envelope(untrained, src, None, "cpu"))

        audio = singer(8.0, 10, DARK, 196.0)
        trained = vm.build_torch_decoder()
        opt = torch.optim.AdamW(trained.parameters(), lr=3e-3)
        ct = torch.tensor(vm.content_features(audio), dtype=torch.float32)[None]
        tt = torch.tensor(vm.target_envelope(audio), dtype=torch.float32)[None]
        for _ in range(300):
            opt.zero_grad()
            nn.functional.l1_loss(trained(ct), tt).backward()
            opt.step()
        check("a trained decoder beats the average envelope",
              trainer._decoder_beats_envelope(trained, src, env, "cpu"))
except ImportError:
    pass


# ── the resampler feeding it has to be band-limited ─────────────────────────

sr_hi = 44_100
tone = np.sin(2 * np.pi * 15_000 * np.arange(sr_hi) / sr_hi) * 0.5
aliased = float(np.max(np.abs(vm.resample_for_content(tone, sr_hi, vm.SR))))
naive = np.interp(np.linspace(0, len(tone) - 1, vm.SR), np.arange(len(tone)), tone)
check("resampling to the model's rate does not fold HF back into the band",
      aliased < 0.05 and float(np.max(np.abs(naive))) > 0.3,
      f"15 kHz leaves {aliased:.3f} here, {float(np.max(np.abs(naive))):.3f} "
      f"through linear interpolation")

kept = vm.resample_for_content(np.sin(2 * np.pi * 440 * np.arange(sr_hi) / sr_hi) * 0.5,
                               sr_hi, vm.SR)
check("and preserves the level of what it keeps",
      abs(float(np.max(np.abs(kept))) - 0.5) < 0.02,
      f"peak {float(np.max(np.abs(kept))):.3f} for a 0.5 input")


passed = sum(1 for r in results if r)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
