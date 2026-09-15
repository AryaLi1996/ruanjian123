#!/usr/bin/env python3
"""Acceptance tests for training-path vocal isolation.

Covers the reported defect: a model trained on un-isolated uploads learns the
backing track and room noise along with the singer, so the result is noisy and
the voice is hard to make out.

The measurements run against a synthetic but full mix — voice with vibrato,
consonant transients and rests, plus drums, bass, wide-panned guitars, hiss,
mains hum and room reverb — scored as scale-invariant SDR against the known
dry voice. That is a real separation metric, so these numbers say whether the
chain works rather than whether it ran.
"""
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf

from trainer import ISOLATION_STEM, MIN_SNR_DB, isolate_vocals, preprocess_vocals
from vocal_isolation import isolate_vocal

SR = 44_100

results = []


def check(name, condition, detail=""):
    results.append(bool(condition))
    print(f"[{'PASS' if condition else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


# ── Synthetic scene ───────────────────────────────────────────────────────────

def make_scene(dur=12.0, seed=0):
    """Return (stereo mix [2, N], dry voice [N]) — a full band around a lead."""
    rng = np.random.default_rng(seed)
    n = int(SR * dur)
    t = np.arange(n) / SR

    notes = [220.0, 246.9, 261.6, 293.7, 329.6, 293.7, 261.6, 246.9]
    f0 = np.zeros(n)
    seg = n // len(notes)
    for i, f in enumerate(notes):
        f0[i * seg:(i + 1) * seg] = f
    f0[len(notes) * seg:] = notes[-1]
    f0 *= 1 + 0.006 * np.sin(2 * np.pi * 5.2 * t)              # vibrato
    phase = 2 * np.pi * np.cumsum(f0) / SR
    voice = sum((0.62 / (k ** 1.25)) * np.sin(k * phase + 0.3 * k) for k in range(1, 14))
    for c in np.linspace(0.4, dur - 0.4, 22):                  # consonants
        i0, w = int(c * SR), int(0.012 * SR)
        voice[i0:i0 + w] += 0.35 * rng.standard_normal(w) * np.hanning(w)
    env = np.ones(n)                                           # rests
    for a, b in [(0.10, 0.16), (0.34, 0.40), (0.60, 0.66), (0.84, 0.90)]:
        env[int(a * n):int(b * n)] = 0.0
    k = np.hanning(2048) / np.sum(np.hanning(2048))
    voice *= np.convolve(env, k, mode="same")
    voice *= 0.5 / (np.max(np.abs(voice)) + 1e-9)

    drums = np.zeros(n)
    for b in np.arange(0, dur, 0.5):                           # kick
        i0, L = int(b * SR), int(0.12 * SR)
        if i0 + L < n:
            drums[i0:i0 + L] += 0.6 * np.sin(2 * np.pi * 58 * np.arange(L) / SR) \
                * np.exp(-np.arange(L) / (0.04 * SR))
    for b in np.arange(0.25, dur, 0.5):                        # snare
        i0, L = int(b * SR), int(0.10 * SR)
        if i0 + L < n:
            drums[i0:i0 + L] += 0.45 * rng.standard_normal(L) \
                * np.exp(-np.arange(L) / (0.02 * SR))

    bass = 0.45 * np.sin(2 * np.pi * 82.4 * t) + 0.2 * np.sin(2 * np.pi * 164.8 * t)
    gtr_l = 0.30 * np.sin(2 * np.pi * 392 * t + 0.7) + 0.18 * np.sin(2 * np.pi * 587 * t + 1.9)
    gtr_r = 0.30 * np.sin(2 * np.pi * 494 * t + 2.2) + 0.18 * np.sin(2 * np.pi * 740 * t + 0.4)
    hum = 0.02 * np.sin(2 * np.pi * 50 * t) + 0.012 * np.sin(2 * np.pi * 150 * t)

    ir = np.zeros(int(0.25 * SR))                              # room reverb
    for _ in range(40):
        idx = int(rng.uniform(0.005, 0.25) * SR)
        if idx < len(ir):
            ir[idx] += rng.standard_normal() * np.exp(-idx / (0.07 * SR))
    ir[0] = 1.0
    wet = np.convolve(voice, ir, mode="full")[:n]
    wet *= np.max(np.abs(voice)) / (np.max(np.abs(wet)) + 1e-9)
    voice_room = 0.85 * voice + 0.15 * wet

    left = voice_room + 0.9 * drums + bass + gtr_l + 0.035 * rng.standard_normal(n) + hum
    right = voice_room + 0.9 * drums + bass + gtr_r + 0.035 * rng.standard_normal(n) + hum
    peak = max(np.max(np.abs(left)), np.max(np.abs(right))) * 1.05
    return np.stack([left, right]) / peak, voice / peak


def sdr_db(est, ref):
    """Scale-invariant SDR: the ref-aligned component against everything else."""
    n = min(len(est), len(ref))
    e = np.asarray(est[:n], dtype=np.float64) - np.mean(est[:n])
    r = np.asarray(ref[:n], dtype=np.float64) - np.mean(ref[:n])
    s = (np.dot(e, r) / (np.dot(r, r) + 1e-12)) * r
    return float(10 * np.log10((np.sum(s ** 2) + 1e-12) / (np.sum((e - s) ** 2) + 1e-12)))


def fir_lowpass(fc, n=127):
    k = np.arange(n) - (n - 1) / 2.0
    f = fc / SR
    with np.errstate(divide="ignore", invalid="ignore"):
        h = np.where(k == 0, 2 * f, np.sin(2 * np.pi * f * k) / (np.pi * k))
    h *= np.hamming(n)
    return h / h.sum()


tmp = Path(tempfile.mkdtemp(prefix="isolation_test_"))
mix, voice = make_scene()
mono = mix.mean(axis=0)

# ── 1. The chain beats every alternative in the repo ──────────────────────────

raw_sdr = sdr_db(mono, voice)
t0 = time.perf_counter()
isolated, metrics = isolate_vocal(mix, SR)
elapsed = time.perf_counter() - t0
iso_sdr = sdr_db(isolated, voice)

# separate(mode="standard") is `mix - lowpass(4 kHz)`: a high-pass residual.
stub_sdr = sdr_db(mono - np.convolve(mono, fir_lowpass(4_000.0), mode="same"), voice)
# A time-domain centre channel keeps the mono sum of everything panned.
centre_sdr = sdr_db((mix[0] + mix[1]) / 2.0, voice)

check("isolation beats the raw mix by a wide margin", iso_sdr - raw_sdr > 8.0,
      f"{raw_sdr:+.2f} dB → {iso_sdr:+.2f} dB ({iso_sdr - raw_sdr:+.2f} dB)")
check("isolation recovers a voice-dominant signal", iso_sdr > 0.0, f"{iso_sdr:+.2f} dB")
check("the FIR stub destroys the voice", stub_sdr < raw_sdr - 20.0,
      f"stub {stub_sdr:+.2f} dB vs raw {raw_sdr:+.2f} dB")
check("isolation beats the FIR stub", iso_sdr > stub_sdr + 20.0,
      f"{iso_sdr:+.2f} dB vs {stub_sdr:+.2f} dB")
check("isolation beats a time-domain centre channel", iso_sdr > centre_sdr + 8.0,
      f"{iso_sdr:+.2f} dB vs {centre_sdr:+.2f} dB")
check("reported SNR gain is real and positive", metrics["snr_gain_db"] > 5.0,
      f"SNR {metrics['snr_before_db']} → {metrics['snr_after_db']} dB")
check("isolation runs faster than real time", elapsed < 12.0,
      f"{elapsed:.2f}s for 12s audio (RT {elapsed / 12.0:.3f})")

# ── 2. Every stage earns its place ────────────────────────────────────────────

for stage in ("denoise", "harmonic"):
    partial, _ = isolate_vocal(mix, SR, **{stage: False})
    check(f"disabling {stage} measurably hurts", sdr_db(partial, voice) < iso_sdr - 0.5,
          f"{sdr_db(partial, voice):+.2f} dB vs {iso_sdr:+.2f} dB with it")

# ── 3. Mono uploads — no stereo information to exploit ────────────────────────
# A phone or room recording is the common bad upload and has no stereo cues,
# so it must be carried by the denoise stage alone.

mono_out, mono_metrics = isolate_vocal(mono[None, :], SR)
check("mono uploads are still cleaned up", sdr_db(mono_out, voice) - raw_sdr > 8.0,
      f"{raw_sdr:+.2f} dB → {sdr_db(mono_out, voice):+.2f} dB")
check("mono input is reported as mono", not mono_metrics["stereo"])
check("mono and stereo results agree (no stereo-only stage remains)",
      abs(sdr_db(mono_out, voice) - iso_sdr) < 0.5,
      f"mono {sdr_db(mono_out, voice):+.2f} dB vs stereo {iso_sdr:+.2f} dB")

# ── 4. Clean material must not be damaged ─────────────────────────────────────

clean_out, _ = isolate_vocal(np.stack([voice, voice]), SR)
check("a clean vocal survives isolation intact", sdr_db(clean_out, voice) > 15.0,
      f"{sdr_db(clean_out, voice):+.2f} dB")

# ── 5. Degenerate input must not crash or produce NaN ─────────────────────────

for name, sig in [("silence", np.zeros((2, SR))),
                  ("shorter than one FFT frame", np.full((2, 100), 0.1)),
                  ("DC only", np.full((2, SR), 0.3)),
                  ("a single sample", np.array([[0.5], [0.5]]))]:
    try:
        out, _m = isolate_vocal(sig, SR)
        ok = len(out) == sig.shape[1] and bool(np.all(np.isfinite(out)))
        check(f"{name} is handled", ok, f"len={len(out)}")
    except Exception as exc:                     # noqa: BLE001 - that is the check
        check(f"{name} is handled", False, f"raised {type(exc).__name__}: {exc}")

# ── 6. Trainer integration ────────────────────────────────────────────────────

data_dir = tmp / "data"
data_dir.mkdir()
sf.write(str(data_dir / "take01.wav"), mix.T, SR, subtype="PCM_16")

src_dir, report = isolate_vocals(data_dir, tmp / "_isolated")
check("a dirty upload is routed through isolation", report["n_isolated"] == 1,
      f"isolated={report['n_isolated']} clean={report['n_clean']} failed={report['n_failed']}")
check("training reads from the isolated directory", src_dir != data_dir)
check("the report carries a measured SNR gain", (report["snr_gain_db"] or 0) > 0,
      f"{report['snr_before_db']} → {report['snr_after_db']} dB")
check("the isolated stem is named for what it is",
      any(ISOLATION_STEM in p.name for p in src_dir.glob("*.wav")))
check("isolated output feeds preprocess_vocals",
      preprocess_vocals(src_dir, tmp / "_processed") > 0)

# Verification: material that stays noisy is named, not waved through.
noisy_dir = tmp / "noisy"
noisy_dir.mkdir()
rng = np.random.default_rng(7)
hopeless = 0.5 * rng.standard_normal((SR * 6, 2)).astype(np.float32)   # pure noise
sf.write(str(noisy_dir / "hopeless.wav"), hopeless, SR, subtype="PCM_16")
_src, noisy_report = isolate_vocals(noisy_dir, tmp / "_isolated_noisy")
check("material that stays noisy is reported unverified",
      not noisy_report["verified"] and noisy_report["unverified_files"],
      f"verified={noisy_report['verified']} files={noisy_report['unverified_files']}")

# Clean material skips isolation entirely.
clean_dir = tmp / "clean"
clean_dir.mkdir()
dry = voice.copy()
dry[:len(dry) // 4] *= 0.0005            # real silence, so the SNR proxy reads high
sf.write(str(clean_dir / "dry.wav"), np.stack([dry, dry], axis=1), SR, subtype="PCM_16")
clean_src, clean_report = isolate_vocals(clean_dir, tmp / "_isolated_clean")
check("a clean upload skips isolation", clean_report["n_isolated"] == 0,
      f"snr={clean_report['snr_before_db']} dB, floor={MIN_SNR_DB} dB")
check("a clean upload is trained from in place", clean_src == clean_dir)
check("a clean upload verifies", clean_report["verified"])

off_src, off_report = isolate_vocals(data_dir, tmp / "_off", enabled=False)
check("isolate=False is a no-op", off_src == data_dir and off_report["n_isolated"] == 0)
check("opting out is reported", off_report["unavailable"] == "disabled by caller")

empty = tmp / "empty"
empty.mkdir()
empty_src, empty_report = isolate_vocals(empty, tmp / "_empty")
check("an empty directory is handled", empty_src == empty and empty_report["n_files"] == 0)

shutil.rmtree(tmp, ignore_errors=True)

passed = sum(1 for r in results if r)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
