#!/usr/bin/env python3
"""Acceptance tests for Ticket 16: pitch analysis ("分析音高").

Generates synthetic vocal-like clips (no real recordings needed) and checks
analyze_pitch() against the ticket's acceptance criteria:
  - a 17s clip peaking at F5 returns max_midi for F5 within 3s
  - a region selection isolates pitch within that region only
  - an empty/omitted region falls back to analyzing the whole track
  - a 30s clip completes within the 3s performance budget
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf

from pitch_analysis import analyze_pitch, hz_to_midi

TMP_DIR = Path(__file__).parent / "_test_data"
TMP_DIR.mkdir(exist_ok=True)


def _tone(freqs_hz, dur_sec, sr=44_100):
    """A pure sine sweep between the given frequencies (simple stand-in for
    a vocal note — pyin tracks pure tones the same way it tracks a voiced
    note's fundamental)."""
    n = int(sr * dur_sec)
    t = np.linspace(0, dur_sec, n, dtype=np.float64)
    freq = np.interp(t, np.linspace(0, dur_sec, len(freqs_hz)), freqs_hz)
    y = 0.5 * np.sin(2 * np.pi * np.cumsum(freq) / sr)
    return y.astype(np.float32), sr


results = []


def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {name}{'  — ' + detail if detail else ''}")
    results.append(condition)


# ── Test 1: 17s clip, F#4 -> F5, max_midi within 3s ────────────────────────
print("=== Test 1: 17s clip peaking at F5, within 3s ===")
F_SHARP_4 = 369.99   # MIDI 66
F5        = 698.46   # MIDI 77
y, sr = _tone([F_SHARP_4, F_SHARP_4, F5], 17.0)
clip_path = TMP_DIR / "_pitch_test_17s.wav"
sf.write(clip_path, y, sr)

t0 = time.perf_counter()
res = analyze_pitch(str(clip_path), 0, 17)
elapsed = time.perf_counter() - t0

print(f"  elapsed={elapsed:.2f}s  max_midi={res['max_midi']}  avg_midi={res['avg_midi']}")
check("completes within 3s", elapsed <= 3.0, f"{elapsed:.2f}s")
check("max_midi matches F5 (77)", res["max_midi"] == round(hz_to_midi(F5)), f"got {res['max_midi']}")
check("contour is a non-empty list", isinstance(res["contour"], list) and len(res["contour"]) > 0)


# ── Test 2: region selection isolates pitch within the region ─────────────
print("\n=== Test 2: region selection (first 5s only) ===")
res_region = analyze_pitch(str(clip_path), 0, 5)
expected_low = round(hz_to_midi(F_SHARP_4))
check(
    "region max_midi reflects only the selected (low) segment",
    res_region["max_midi"] == expected_low,
    f"expected {expected_low}, got {res_region['max_midi']}",
)


# ── Test 3: no region (None, None) analyzes the whole track ───────────────
print("\n=== Test 3: no region selected -> whole track analyzed ===")
res_whole = analyze_pitch(str(clip_path), None, None)
check(
    "whole-track result matches explicit full-range result",
    res_whole["max_midi"] == res["max_midi"],
    f"whole={res_whole['max_midi']} vs explicit={res['max_midi']}",
)

# Invalid/empty region (end <= start) should also fall back to the whole track.
res_invalid = analyze_pitch(str(clip_path), 10, 10)
check(
    "invalid region (end <= start) falls back to whole track",
    res_invalid["max_midi"] == res["max_midi"],
)


# ── Test 4: 30s clip stays within the 3s performance budget ───────────────
print("\n=== Test 4: 30s clip performance budget ===")
y30, sr30 = _tone([220.0, 260.0, 300.0, 260.0, 220.0], 30.0)
clip30_path = TMP_DIR / "_pitch_test_30s.wav"
sf.write(clip30_path, y30, sr30)

t0 = time.perf_counter()
res30 = analyze_pitch(str(clip30_path), 0, 30)
elapsed30 = time.perf_counter() - t0
print(f"  elapsed={elapsed30:.2f}s  max_midi={res30['max_midi']}")
check("30s clip completes within 3s", elapsed30 <= 3.0, f"{elapsed30:.2f}s")


# ── Test 5: silence returns a safe zero result, no crash ──────────────────
print("\n=== Test 5: silence ===")
silence = np.zeros(44_100 * 2, dtype=np.float32)
silence_path = TMP_DIR / "_pitch_test_silence.wav"
sf.write(silence_path, silence, 44_100)
res_silence = analyze_pitch(str(silence_path), 0, 2)
check("silence returns max_midi 0", res_silence["max_midi"] == 0)
check("silence returns avg_midi 0.0", res_silence["avg_midi"] == 0.0)


# ── Cleanup + summary ───────────────────────────────────────────────────────
for p in (clip_path, clip30_path, silence_path):
    try:
        p.unlink()
    except OSError:
        pass

passed = sum(1 for r in results if r)
total = len(results)
print(f"\n{passed}/{total} checks passed")
sys.exit(0 if passed == total else 1)
