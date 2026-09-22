#!/usr/bin/env python3
"""Regression guard for spectral-envelope timbre transfer.

Before this, the cover flow built its "AI voice" from nothing: a sine at the
reference's f0 pushed through near-identity weights, with the phoneme sequence
hardcoded to a single vowel (`["a","e","i","o","u"][0:1] * n_phon`). A whole
song came out as one sustained drone over the backing — the noise users
reported — and thirty minutes of training could not change it, because nothing
in the training loop reached the phonemes or the excitation.

Now the reference vocal is the excitation and only its timbre moves. These
checks pin the three things that silently broke while that was being built,
each of which produced output *further* from the target than doing nothing:

  1. resample_envelope interpolating by normalised bin index, mapping
     0-11 kHz onto 0-22 kHz and moving every formant up an octave.
  2. the cepstral lifter given as a coefficient count, so the envelope divided
     out at 44.1 kHz was twice as coarse as the one multiplied in at 22 kHz
     and the two did not cancel.
  3. the envelope learned downstream of isolate_vocals, which is an SI-SDR
     denoiser and recolours what it cleans — so the model stored the filter's
     timbre rather than the singer's.

Measurement is a third-octave log-spectrum profile from 350 Hz up, not a
cepstral envelope: a lifter wide enough to resolve a formant also tracks the
harmonics, so a cepstral measure moves with pitch and rates two takes of one
singer further apart than two different singers.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np

from timbre import (
    DEFAULT_STRENGTH,
    cepstrum_order,
    envelope_from_audio,
    resample_envelope,
    transfer,
)

SR = 44_100
results = []


def check(name, condition, detail=""):
    results.append(bool(condition))
    print(f"[{'PASS' if condition else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


# ── Fixture: two voices differing only by a smooth vocal-tract response ───────

_HZ = np.array([0, 150, 300, 500, 800, 1200, 2000, 3200, 5000, 8000, 12000, 22050.])
DARK = np.array([0, 4, 8, 10, 6, 0, -6, -12, -16, -20, -24, -26.])
BRIGHT = np.array([0, -8, -6, -2, 2, 6, 9, 8, 5, 2, 0, -2.])


def _excitation(n, seed, base):
    rng = np.random.default_rng(seed)
    t = np.arange(n) / SR
    notes = np.array([1.0, 1.122, 1.189, 1.335, 1.498, 1.335, 1.189, 1.0]) * base
    f0 = np.zeros(n)
    seg = n // len(notes)
    for i, f in enumerate(notes):
        f0[i * seg:(i + 1) * seg] = f
    f0[len(notes) * seg:] = notes[-1]
    f0 *= 1 + 0.005 * np.sin(2 * np.pi * 5.1 * t)
    ph = 2 * np.pi * np.cumsum(f0) / SR
    x = sum((1.0 / k) * np.sin(k * ph + 0.4 * k) for k in range(1, 90))
    for c in np.linspace(0.3, n / SR - 0.3, int(n / SR * 2)):          # consonants
        i0, w = int(c * SR), int(0.012 * SR)
        if i0 + w < n:
            x[i0:i0 + w] += 0.30 * np.max(np.abs(x)) * rng.standard_normal(w) * np.hanning(w)
    gate = np.ones(n)
    for lo, hi in [(.12, .18), (.42, .48), (.72, .78)]:                # rests
        gate[int(lo * n):int(hi * n)] = 0.0
    k = np.hanning(2048) / np.sum(np.hanning(2048))
    return x * np.convolve(gate, k, mode="same")


def _stft(x, n_fft=2048, hop=512):
    w = np.hanning(n_fft + 1)[:-1]
    pad = n_fft // 2
    xp = np.pad(np.asarray(x, np.float64), (pad, pad), mode="reflect")
    nf = 1 + (len(xp) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(nf)[:, None]
    return np.fft.rfft(xp[idx] * w, axis=-1).T, w, pad, nf


def _istft(spec, w, pad, nf, length, n_fft=2048, hop=512):
    frames = np.fft.irfft(spec.T, n=n_fft, axis=-1) * w
    acc = np.zeros((nf - 1) * hop + n_fft)
    ws = np.zeros_like(acc)
    for i in range(nf):
        acc[i * hop:i * hop + n_fft] += frames[i]
        ws[i * hop:i * hop + n_fft] += w ** 2
    return (acc / np.maximum(ws, 1e-10))[pad:pad + length]


def _shape(x, curve_db):
    spec, w, pad, nf = _stft(x)
    hz = np.linspace(0, SR / 2, spec.shape[0])
    gain = 10 ** (np.interp(hz, _HZ, curve_db) / 20.0)
    return _istft(spec * gain[:, None], w, pad, nf, len(x))


def singer(seconds, seed, curve, base=200.0):
    y = _shape(_excitation(int(SR * seconds), seed, base), curve)
    return (y * 0.5 / (np.max(np.abs(y)) + 1e-9)).astype(np.float32)


def profile(x, sr=SR):
    """Third-octave log-spectrum from 350 Hz to ~8.8 kHz, level-normalised.

    From 350 Hz because the bands below it hold one or two harmonics of a sung
    note, so their level tracks the melody rather than the voice.
    """
    x = np.asarray(x, np.float64)
    n_fft = 4096
    if len(x) < n_fft:
        x = np.pad(x, (0, n_fft - len(x)))
    w = np.hanning(n_fft + 1)[:-1]
    hop = n_fft // 2
    nf = 1 + (len(x) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(nf)[:, None]
    psd = (np.abs(np.fft.rfft(x[idx] * w, axis=-1)) ** 2).mean(axis=0)
    hz = np.linspace(0, sr / 2, len(psd))
    edges = 350.0 * 2 ** (np.arange(0, 15) / 3.0)
    bands = np.array([psd[(hz >= lo) & (hz < hi)].mean()
                      if ((hz >= lo) & (hz < hi)).any() else 1e-12
                      for lo, hi in zip(edges[:-1], edges[1:])])
    b = np.log(bands + 1e-12)
    return b - b.mean()


def timbre_distance(a, b):
    return float(np.sqrt(np.mean((profile(a) - profile(b)) ** 2)))


def diction(a, b):
    """Correlation of short-time log energy — same syllables at same times."""
    h = 512
    m = min(len(a), len(b)) // h * h
    f = lambda x: np.log(np.sqrt((np.asarray(x[:m], np.float64).reshape(-1, h) ** 2)
                                 .mean(1)) + 1e-6)
    u, v = f(a), f(b)
    u -= u.mean()
    v -= v.mean()
    return float(np.dot(u, v) / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-9))


# ── The metric has to work before anything measured with it means something ───

target_train = singer(8.0, 10, DARK, base=196.0)
target_take = singer(8.0, 5, DARK, base=233.0)
reference = singer(8.0, 77, BRIGHT, base=233.0)

same_singer = timbre_distance(target_train, target_take)
diff_singer = timbre_distance(target_take, reference)
check("the timbre metric separates singers, not pitches",
      same_singer < 0.5 and diff_singer > 2.0,
      f"same singer {same_singer:.2f}, different singers {diff_singer:.2f}")

FLOOR = same_singer          # nothing can measure closer than this
BASELINE = timbre_distance(reference, target_take)


# ── The transfer itself ───────────────────────────────────────────────────────

def convert(ref, target_audio, strength=DEFAULT_STRENGTH, learn_sr=22_050):
    """Learn `target_audio`'s envelope the way trainer does, apply it the way
    cover_synthesis does — including the sample-rate change between the two,
    which is where this went wrong twice."""
    n = len(target_audio) // 2 * 2
    at_learn_sr = np.interp(np.arange(0, n, SR / learn_sr),
                            np.arange(n), np.asarray(target_audio[:n], np.float64))
    env = envelope_from_audio(at_learn_sr, 1024, 256, cepstrum_order(learn_sr))

    spec, w, pad, nf = _stft(ref)
    wide = resample_envelope(env, spec.shape[0], learn_sr, SR)
    mag = transfer(np.abs(spec), wide, strength=strength,
                   n_cepstrum=cepstrum_order(SR))
    return _istft(mag * np.exp(1j * np.angle(spec)), w, pad, nf, len(ref))


converted = convert(reference, target_train)
to_target = timbre_distance(converted, target_take)
to_ref = timbre_distance(converted, reference)

check("conversion moves the reference towards the target singer",
      to_target < BASELINE * 0.5,
      f"{to_target:.2f} vs {BASELINE:.2f} untouched (floor {FLOOR:.2f})")
check("conversion moves the reference away from its own timbre",
      to_ref > to_target,
      f"{to_ref:.2f} from the reference, {to_target:.2f} from the target")
check("conversion keeps the words and their timing",
      diction(converted, reference) > 0.9,
      f"log-energy correlation {diction(converted, reference):.3f}")

quiet = lambda x: 20 * np.log10(
    np.percentile(np.sqrt((np.asarray(x[:len(x) // 2048 * 2048], np.float64)
                           .reshape(-1, 2048) ** 2).mean(1)) + 1e-12, 5)
    / (np.percentile(np.sqrt((np.asarray(x[:len(x) // 2048 * 2048], np.float64)
                              .reshape(-1, 2048) ** 2).mean(1)) + 1e-12, 90)))
check("conversion does not lift the noise floor in the rests",
      quiet(converted) <= quiet(reference) + 3.0,
      f"{quiet(converted):.1f} dB vs {quiet(reference):.1f} dB on the reference")

check("strength 0 is exactly the identity",
      np.array_equal(transfer(np.abs(_stft(reference)[0]), np.ones(1025), strength=0.0),
                     np.abs(_stft(reference)[0])))


# ── Bug 1: the envelope must be resampled by frequency, not by bin index ──────

peak_hz = 700.0
bins_lo = 513
env_lo = np.ones(bins_lo)
env_lo[round(peak_hz / (22_050 / 2) * (bins_lo - 1))] = 10.0
wide = resample_envelope(env_lo, 1025, 22_050, SR)
moved_to = float(np.argmax(wide)) * (SR / 2) / 1024
check("resampling an envelope across sample rates keeps formants in place",
      abs(moved_to - peak_hz) < 40.0,
      f"a {peak_hz:.0f} Hz peak landed at {moved_to:.0f} Hz "
      f"(bin-index interpolation put it at {peak_hz * 2:.0f} Hz)")
check("bins above the learned Nyquist hold rather than invent",
      np.all(wide[-40:] == wide[-1]))


# ── Bug 2: the lifter is a quefrency, so its order follows the sample rate ────

# Cepstral index n is a period of n/sr seconds, so doubling the rate has to
# double the order for the lifter to mean the same smoothing (±1 for rounding).
check("lifter order scales with the sample rate",
      abs(cepstrum_order(44_100) - 2 * cepstrum_order(22_050)) <= 1,
      f"{cepstrum_order(22_050)} at 22.05 kHz, {cepstrum_order(44_100)} at 44.1 kHz")

mismatched = convert(reference, target_train)
spec, w, pad, nf = _stft(reference)
wide_env = resample_envelope(
    envelope_from_audio(np.interp(np.arange(0, len(target_train), 2.0),
                                  np.arange(len(target_train)),
                                  np.asarray(target_train, np.float64)),
                        1024, 256, cepstrum_order(22_050)),
    spec.shape[0], 22_050, SR)
wrong_order = _istft(
    transfer(np.abs(spec), wide_env, n_cepstrum=cepstrum_order(22_050))
    * np.exp(1j * np.angle(spec)), w, pad, nf, len(reference))
check("matching the lifter to the rate beats inheriting the learned order",
      timbre_distance(mismatched, target_take) <= timbre_distance(wrong_order, target_take),
      f"{timbre_distance(mismatched, target_take):.2f} matched vs "
      f"{timbre_distance(wrong_order, target_take):.2f} inherited")


# ── Bug 3: the envelope is learned from the raw upload, not post-isolation ────

import soundfile as sf  # noqa: E402

import trainer  # noqa: E402
from cover_synthesis import _apply_timbre, _load_timbre  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    raw = Path(tmp) / "raw"
    raw.mkdir()
    sf.write(str(raw / "a.wav"), target_train, SR)
    learned = trainer._learn_timbre(raw)
    check("trainer learns an envelope from the uploaded audio",
          learned is not None and learned.shape == (513,),
          f"{None if learned is None else learned.shape}")

    truth = envelope_from_audio(
        np.interp(np.arange(0, len(target_train), 2.0), np.arange(len(target_train)),
                  np.asarray(target_train, np.float64)),
        1024, 256, cepstrum_order(22_050))
    norm = lambda e: np.log(e / np.exp(np.mean(np.log(e + 1e-8))) + 1e-8)
    err = float(np.sqrt(np.mean((norm(learned.astype(np.float64)) - norm(truth)) ** 2)))
    check("the stored envelope is the uploaded singer's", err < 0.2, f"{err:.3f}")

    check("trainer reports no envelope when there is nothing to learn from",
          trainer._learn_timbre(Path(tmp) / "absent") is None)

    # Round-trip through the .onnx: the envelope rides inside the model so it
    # cannot go missing separately from it.
    model_path = Path(tmp) / "m.onnx"
    trainer.export_to_onnx(trainer.MicroVITSModel(), model_path, timbre_envelope=learned)
    loaded = _load_timbre(model_path)
    check("the envelope survives the ONNX round-trip",
          loaded is not None and np.allclose(loaded, learned, atol=1e-6))

    trainer.export_to_onnx(trainer.MicroVITSModel(), model_path)
    check("a model with no envelope reads back as None",
          _load_timbre(model_path) is None)

check("no envelope leaves the reference voice untouched rather than guessing",
      np.allclose(_apply_timbre(reference, None), reference, atol=1e-6))

passed = sum(1 for r in results if r)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
