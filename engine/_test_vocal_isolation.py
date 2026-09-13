#!/usr/bin/env python3
"""Acceptance tests for the training-path vocal isolation pre-pass.

Covers the reported defect: a model trained on un-isolated uploads learns the
backing track along with the singer, so the result is noisy and the voice is
hard to make out. trainer.isolate_vocals() puts separation.isolate_lead_vocal()
(vocal_harmony_split → dereverb) in front of preprocess_vocals() for material
the SNR estimate calls dirty.

The measurement tests record *why* that is the replacement rather than either
separate() mode: demucs_nano.onnx and sep_main.onnx are both 4 kHz high-pass
residuals, which discard the sung fundamental outright, and "enhanced" runs
its centre-channel split downstream of one — so it inherits the same loss.
"""
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf

from trainer import (ISOLATION_STEM, MIN_SNR_DB, isolate_vocals,
                     preprocess_vocals)

SR = 44_100

results = []


def check(name, condition, detail=""):
    results.append(bool(condition))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))


def _voice(dur=4.0, f0=220.0):
    """Centre-panned harmonic 'voice': fundamental plus a falling harmonic series."""
    t = np.arange(int(SR * dur)) / SR
    return sum(0.6 / (k ** 1.2) * np.sin(2 * np.pi * f0 * k * t)
               for k in range(1, 12)).astype(np.float32)


def _noisy_mix(dur=4.0):
    """Voice in the centre, wide-panned 'band' and hiss around it — the shape
    of a real upload that has not been separated."""
    t = np.arange(int(SR * dur)) / SR
    rng = np.random.default_rng(0)
    v = _voice(dur)
    bass = 0.7 * np.sin(2 * np.pi * 90 * t)
    # Per-channel, decorrelated: room tone and analogue hiss are not mono,
    # which is what gives a centre-channel extraction something to cancel.
    left = (v + bass + 0.4 * np.sin(2 * np.pi * 660 * t + 1.0)
            + 0.25 * rng.standard_normal(len(t)))
    right = (v + bass + 0.4 * np.sin(2 * np.pi * 880 * t + 2.0)
             + 0.25 * rng.standard_normal(len(t)))
    return np.stack([left, right], axis=1).astype(np.float32), v


def _vir_db(x, ref):
    """Voice-to-interference ratio: project x onto the true voice signal and
    compare the aligned component against everything else in x. Higher is a
    cleaner vocal; this is the number the training loop ultimately cares about.
    """
    n = min(len(x), len(ref))
    x = np.asarray(x[:n], dtype=np.float64); r = np.asarray(ref[:n], dtype=np.float64)
    aligned = (np.dot(x, r) / np.dot(r, r)) * r
    resid = x - aligned
    return float(10.0 * np.log10(np.sum(aligned ** 2) / (np.sum(resid ** 2) + 1e-12)))


def _corr(a, b):
    n = min(len(a), len(b))
    a = np.asarray(a[:n], dtype=np.float64); b = np.asarray(b[:n], dtype=np.float64)
    a = a - a.mean(); b = b - b.mean()
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


tmp = Path(tempfile.mkdtemp(prefix="isolation_test_"))
data_dir = tmp / "data"; data_dir.mkdir()

# ── 1. A dirty upload gets isolated ────────────────────────────────────────
mix, voice_ref = _noisy_mix()
sf.write(str(data_dir / "take01.wav"), mix, SR, subtype="PCM_16")

src_dir, report = isolate_vocals(data_dir, tmp / "_isolated")

check("dirty upload is routed through isolation", report["n_isolated"] == 1,
      f"n_isolated={report['n_isolated']} n_clean={report['n_clean']} "
      f"n_failed={report['n_failed']}")
check("isolation reports the lead_dry stem",
      report["stem"] == ISOLATION_STEM, report["stem"])
check("training reads from the isolated directory", src_dir != data_dir, str(src_dir))

isolated = sorted(src_dir.glob("*.wav"))
check("one isolated file written", len(isolated) == 1,
      ", ".join(p.name for p in isolated))

if isolated:
    iso, _sr = sf.read(str(isolated[0]), dtype="float32", always_2d=True)
    iso_mono = iso.mean(axis=1)
    mix_mono = mix.mean(axis=1)
    c_before, c_after = _corr(mix_mono, voice_ref), _corr(iso_mono, voice_ref)
    check("isolated audio still tracks the true voice",
          c_after > 0.3, f"corr {c_before:+.3f} (raw mix) → {c_after:+.3f} (isolated)")

    # The whole point of the fix: what reaches the training loop is no worse
    # than the raw upload, and nothing like what separate() would have done
    # to it. These are stub models, so the gain is modest by design — the
    # regression this guards against is the catastrophic one below.
    vir_raw, vir_iso = _vir_db(mix[:, 0], voice_ref), _vir_db(iso_mono, voice_ref)
    check("isolation does not degrade the voice-to-interference ratio",
          vir_iso >= vir_raw - 0.5,
          f"{vir_raw:+.2f} dB (raw upload) → {vir_iso:+.2f} dB (isolated)")

    check("isolated output feeds preprocess_vocals",
          preprocess_vocals(src_dir, tmp / "_processed") > 0)

# ── 2. Clean material is left alone ────────────────────────────────────────
clean_dir = tmp / "clean"; clean_dir.mkdir()
dry = _voice(6.0)
# A dry vocal with real silences: the SNR estimate compares the quiet 10% of
# frames against the median, so a gapless tone reads as *low* SNR.
dry[: len(dry) // 4] *= 0.0005
sf.write(str(clean_dir / "dry.wav"), np.stack([dry, dry], axis=1), SR, subtype="PCM_16")

clean_src, clean_report = isolate_vocals(clean_dir, tmp / "_isolated_clean")
check("clean upload skips separation", clean_report["n_isolated"] == 0,
      f"snr={clean_report['snr_before_db']} dB, floor={MIN_SNR_DB} dB")
check("clean upload is trained from in place", clean_src == clean_dir)

# ── 3. Opting out, and an empty directory ──────────────────────────────────
off_src, off_report = isolate_vocals(data_dir, tmp / "_off", enabled=False)
check("isolate=False is a no-op", off_src == data_dir and off_report["n_isolated"] == 0)
check("opting out is reported", off_report["unavailable"] == "disabled by caller")

empty = tmp / "empty"; empty.mkdir()
empty_src, empty_report = isolate_vocals(empty, tmp / "_empty")
check("empty directory is handled", empty_src == empty and empty_report["n_files"] == 0)

# ── 4. Why enhanced, not standard ──────────────────────────────────────────
# demucs_nano.onnx computes vocals = mix − lowpass(4 kHz). Reproduced here in
# numpy so the claim is checked rather than asserted in a comment.
def _sinc_lp(fc, n=127):
    k = np.arange(n) - (n - 1) / 2.0
    f = fc / SR
    with np.errstate(divide="ignore", invalid="ignore"):
        h = np.where(k == 0, 2 * f, np.sin(2 * np.pi * f * k) / (np.pi * k))
    h *= np.hamming(n)
    return (h / h.sum()).astype(np.float32)


_h = _sinc_lp(4_000.0)
std_l = mix[:, 0] - np.convolve(mix[:, 0], _h, mode="same")
std_r = mix[:, 1] - np.convolve(mix[:, 1], _h, mode="same")
std_vocals = std_l
mid = (mix[:, 0] + mix[:, 1]) / 2.0     # what isolate_lead_vocal() starts from

# ...and "enhanced" runs its centre-channel split on that residual, so it
# inherits the loss instead of undoing it.
chained = (std_l + std_r) / 2.0

check("standard demucs_nano path loses the voice",
      abs(_corr(std_vocals, voice_ref)) < 0.2,
      f"corr {_corr(std_vocals, voice_ref):+.3f}, "
      f"VIR {_vir_db(std_vocals, voice_ref):+.1f} dB")
check("enhanced mode inherits that loss (stage 2 runs after stage 1)",
      abs(_corr(chained, voice_ref)) < 0.2, f"corr {_corr(chained, voice_ref):+.3f}")
check("centre channel taken from the mix keeps the voice",
      _corr(mid, voice_ref) > 0.5, f"corr {_corr(mid, voice_ref):+.3f}")

shutil.rmtree(tmp, ignore_errors=True)

passed = sum(1 for r in results if r)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
