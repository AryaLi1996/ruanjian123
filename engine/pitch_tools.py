"""
Pitch analysis + shifting — Ticket 16 (vocal pitch/range analysis) and
Ticket 19 (Pitch Shift / Key Change Control) share this module:

  - estimate_vocal_range(): librosa.pyin-based f0 tracking over one or more
    of the user's own vocal recordings (the material uploaded in Model
    Training), reduced to a robust [min_midi, max_midi] — the "user's vocal
    range" Ticket 19's recommendation formula needs.
  - shift_pitch(): librosa.effects.pitch_shift on a target song's cached
    audio, with an on-disk cache keyed by (song, semitones) so re-selecting
    a shift already computed this session (or a previous one) is instant
    and the shifted file survives for later use as a training target.

Both functions import librosa lazily (main.py's handlers do the same for
every other heavy dependency) so a process that never touches pitch
features doesn't pay for the import.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional


def estimate_vocal_range(
    paths: list[str],
    fmin_hz: float = 65.0,   # ~C2 — below the lowest realistic chest voice
    fmax_hz: float = 1_000.0,  # ~B5 — above the highest realistic falsetto/head voice
) -> dict:
    """
    Robust [min_midi, max_midi] vocal range across one or more recordings.

    fmin/fmax bound pyin's search to the human voice so octave errors and
    any instrumental bleed-through in the recording can't blow the range
    out to something unusable; the 5th/95th percentile trim on top of that
    guards against the handful of frames pyin still gets wrong on noisy
    home-recorded material. Files that fail to load (missing, unsupported
    codec) are skipped rather than failing the whole analysis.
    """
    import numpy as np
    import librosa

    all_midi: list[float] = []
    for p in paths:
        try:
            y, sr = librosa.load(p, sr=None, mono=True)
        except Exception:
            continue
        if y.size == 0:
            continue
        f0, voiced_flag, _voiced_probs = librosa.pyin(y, sr=sr, fmin=fmin_hz, fmax=fmax_hz)
        voiced = f0[voiced_flag & np.isfinite(f0)]
        if voiced.size:
            all_midi.extend(librosa.hz_to_midi(voiced).tolist())

    if not all_midi:
        return {"min_midi": None, "max_midi": None, "min_note": None, "max_note": None, "n_frames_voiced": 0}

    arr = np.array(all_midi, dtype=np.float64)
    lo, hi = (float(v) for v in np.percentile(arr, [5, 95]))
    return {
        "min_midi":       round(lo, 1),
        "max_midi":       round(hi, 1),
        "min_note":       librosa.midi_to_note(round(lo)),
        "max_note":       librosa.midi_to_note(round(hi)),
        "n_frames_voiced": int(arr.size),
    }


def shift_pitch(
    input_path: str,
    semitones: float,
    cache_dir: Path,
    cache_key: Optional[str] = None,
) -> dict:
    """
    Applies librosa.effects.pitch_shift to `input_path` and caches the
    result under `cache_dir`, keyed by (cache_key or a hash of input_path,
    whole-semitone shift) — the Tune slider is integer-stepped, so rounding
    before the cache lookup means dragging back to a shift already computed
    this session (or a previous one, since the cache is on disk) is instant
    instead of re-running the DSP.

    semitones == 0 is a no-op: the caller's audio is already what it should
    be, so the original path is returned unchanged rather than writing out
    an identical copy.
    """
    import soundfile as sf
    import librosa

    steps = int(round(semitones))
    if steps == 0:
        resolved = str(Path(input_path).resolve())
        return {"output_path": resolved, "cached": True, "semitones": 0}

    cache_dir.mkdir(parents=True, exist_ok=True)
    key = cache_key or hashlib.sha1(str(Path(input_path).resolve()).encode()).hexdigest()[:16]
    # Sanitised the same way library.ts's safeId() is (a song id or file
    # path can contain characters that aren't safe in a filename).
    safe_key = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(key))
    out_path = cache_dir / f"{safe_key}_{steps:+d}.wav"

    if out_path.exists():
        info = sf.info(str(out_path))
        return {"output_path": str(out_path), "cached": True, "semitones": steps, "duration_sec": round(info.duration, 3)}

    y, sr = librosa.load(input_path, sr=None, mono=False)
    shifted = librosa.effects.pitch_shift(y=y, sr=sr, n_steps=float(steps))
    # soundfile wants (frames, channels) for multichannel; librosa's stereo
    # output is (channels, frames), but a mono load comes back as a flat
    # (frames,) array with no channel axis to transpose.
    data = shifted.T if shifted.ndim == 2 else shifted
    sf.write(str(out_path), data, sr, subtype="PCM_16")

    return {
        "output_path": str(out_path),
        "cached":      False,
        "semitones":   steps,
        "duration_sec": round(len(data) / sr, 3),
    }
