"""Ticket 16: pitch analysis ("分析音高").

Extracts the pitch contour of a (sub-)region of an audio file and reports
the highest note found, for the waveform region-selection UI's "Analyze
Pitch" button.

Performance notes (acceptance: <=3s for up to 30s of audio):
  - Only the requested region is read off disk (via soundfile's start/stop),
    never the whole file, so a short region selection on a long song stays
    cheap regardless of the song's total length.
  - The segment is resampled to a fixed, low sample rate before pitch
    tracking. librosa.pyin's cost scales with the number of analysis
    frames (duration / hop_length in *samples*), so a fixed low sample
    rate bounds that cost independent of the source file's sample rate
    (44.1/48kHz masters otherwise take ~2x as long to analyze as 22.05kHz
    ones for no accuracy benefit — vocal fundamentals top out around C7,
    well under the Nyquist frequency of 16kHz).
  - hop_length/resolution are tuned coarser than librosa's defaults, which
    are tuned for research-grade accuracy, not an interactive "highest
    note in this clip" UI affordance — a few cents of extra jitter doesn't
    change which semitone shows up as the max.
"""
from __future__ import annotations

import numpy as np

# MIDI 69 == A4 == 440 Hz; MIDI 60 == C4 ("middle C"), per the ticket spec.
_MIDI_A4 = 69
_FREQ_A4 = 440.0

# Fixed analysis sample rate — see perf notes above. Comfortably above twice
# the highest note pyin is asked to search for (C7 ~= 2093 Hz).
_ANALYSIS_SR = 16000
_HOP_LENGTH  = 1024
_RESOLUTION  = 0.3   # semitone steps searched by pyin; default 0.1 is overkill here


def hz_to_midi(freq_hz: float) -> float:
    """Converts a frequency in Hz to a (fractional) MIDI note number, C4 = 60."""
    if freq_hz is None or freq_hz <= 0 or not np.isfinite(freq_hz):
        return float("nan")
    return float(12.0 * np.log2(freq_hz / _FREQ_A4) + _MIDI_A4)


def analyze_pitch(audio_path: str, start_sec: float | None = None, end_sec: float | None = None) -> dict:
    """Extracts the pitch contour of `audio_path` between `start_sec` and `end_sec`.

    When no region is given (both None), the entire track is analyzed —
    this is also the fallback when the requested region is empty/invalid.

    Returns:
        {
          "max_midi": int,          # highest MIDI note detected (0 if nothing voiced)
          "contour":  List[float],  # per-frame MIDI note, 0.0 for unvoiced/silent frames
          "avg_midi": float,        # mean MIDI note across voiced frames
        }
    """
    import librosa    # noqa: PLC0415 — heavy import, keep off the module's cold path
    import soundfile as sf  # noqa: PLC0415

    with sf.SoundFile(audio_path) as f:
        sr = f.samplerate
        total_frames = len(f)
    total_dur = total_frames / sr if sr else 0.0

    start = float(start_sec) if start_sec is not None else 0.0
    end   = float(end_sec) if end_sec is not None else total_dur
    start = max(0.0, min(start, total_dur))
    end   = max(0.0, min(end, total_dur))
    if end <= start:
        # Invalid/empty selection — fall back to analyzing the whole track.
        start, end = 0.0, total_dur

    i0 = int(start * sr)
    i1 = min(total_frames, int(end * sr))
    if i1 <= i0:
        return {"max_midi": 0, "contour": [], "avg_midi": 0.0}

    y, _ = sf.read(audio_path, start=i0, stop=i1, dtype="float32", always_2d=True)
    segment = y.mean(axis=1).astype(np.float32)  # downmix to mono

    if sr != _ANALYSIS_SR:
        import soxr  # noqa: PLC0415 — direct call, bypasses librosa.resample's slower dispatch path
        segment = soxr.resample(segment, sr, _ANALYSIS_SR, quality="QQ").astype(np.float32)

    if len(segment) == 0:
        return {"max_midi": 0, "contour": [], "avg_midi": 0.0}

    f0, voiced_flag, _voiced_prob = librosa.pyin(
        segment,
        fmin=float(librosa.note_to_hz("C2")),
        fmax=float(librosa.note_to_hz("C7")),
        sr=_ANALYSIS_SR,
        hop_length=_HOP_LENGTH,
        resolution=_RESOLUTION,
    )

    contour: list[float] = []
    voiced_midi: list[float] = []
    for hz, voiced in zip(f0, voiced_flag):
        if voiced and hz is not None and np.isfinite(hz) and hz > 0:
            midi = round(hz_to_midi(float(hz)), 2)
            contour.append(midi)
            voiced_midi.append(midi)
        else:
            # Keep the frame so contour stays time-aligned for a future
            # waveform overlay; 0.0 marks "no pitch detected here".
            contour.append(0.0)

    if not voiced_midi:
        return {"max_midi": 0, "contour": contour, "avg_midi": 0.0}

    return {
        "max_midi": int(round(max(voiced_midi))),
        "contour":  contour,
        "avg_midi": round(float(sum(voiced_midi) / len(voiced_midi)), 2),
    }
