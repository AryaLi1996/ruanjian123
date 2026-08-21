"""
Ticket 19 (Pitch Shift / Key Change Control): shift_pitch() applies
librosa.effects.pitch_shift to a target song's cached audio, with an
on-disk cache keyed by (song, semitones) so re-selecting a shift already
computed this session (or a previous one) is instant and the shifted file
survives for later use as a training target.

The "user's vocal range" half of Ticket 19's recommendation formula comes
from Ticket 16's pitch analysis instead (see engine/pitch_analysis.py's
analyze_pitch, fed the separated lead vocal stem — wired up in CoverView).

Imports librosa lazily (main.py's handlers do the same for every other
heavy dependency) so a process that never touches pitch shifting doesn't
pay for the import.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional


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
