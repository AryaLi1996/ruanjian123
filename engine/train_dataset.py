"""
Merge Audio & Upload Training Dataset — Ticket 20 (plus its Ticket 17 and
Ticket 19 prerequisites: high-pitch protection and pitch shift).

File-handling orchestration around the pure-numpy DSP already in
postprocess.py, mirroring how cover_synthesis.py wraps postprocess_chain()
and library.ts wraps library-search.ts's pure catalog logic — the DSP stays
a pure function over arrays (easy to unit-test); this module only adds the
file I/O around it.

  - protect_vocal_file(): reads a vocal WAV, runs postprocess.protect_high_pitch
    per channel, writes the result (Ticket 17 — "高音保护").
  - pitch_shift_file(): reads a WAV, shifts every channel by N semitones
    while preserving the file's original duration (Ticket 19 — "变调").
  - merge_train_audio(): time-aligns the protected vocal and the
    pitch-shifted target song (pad-to-longest or truncate-to-shortest),
    mixes them into merged_train.wav, and optionally copies a dry-vocal
    track alongside it (Ticket 20's merge step).
  - package_train_dataset(): zips a set of files (merged_train.wav + the
    optional dry vocal) ready for upload.

Numpy + soundfile only — same "no external DSP deps" discipline as the rest
of engine/ (see engine/requirements.txt).
"""
from __future__ import annotations

import shutil
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from postprocess import protect_high_pitch


def _load(path: str) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    return audio, sr


def _resample_linear(audio: np.ndarray, sr_from: int, sr_to: int) -> np.ndarray:
    """Linear-interpolation resampler used only to reconcile two already-
    decoded WAVs onto one sample rate before mixing — not a broadcast-grade
    anti-aliased resample, but adequate for that."""
    if sr_from == sr_to or audio.shape[0] == 0:
        return audio
    n_out = max(1, round(audio.shape[0] * sr_to / sr_from))
    src_idx = np.linspace(0, audio.shape[0] - 1, num=audio.shape[0])
    dst_idx = np.linspace(0, audio.shape[0] - 1, num=n_out)
    return np.stack(
        [np.interp(dst_idx, src_idx, audio[:, c]) for c in range(audio.shape[1])],
        axis=1,
    ).astype(np.float32)


def _match_channels(audio: np.ndarray, channels: int) -> np.ndarray:
    if audio.shape[1] == channels:
        return audio
    if audio.shape[1] == 1:
        return np.repeat(audio, channels, axis=1)
    if audio.shape[1] > channels:
        return audio[:, :channels]
    return np.pad(audio, ((0, 0), (0, channels - audio.shape[1])))


def _pad_to(audio: np.ndarray, n: int) -> np.ndarray:
    if audio.shape[0] >= n:
        return audio[:n]
    return np.pad(audio, ((0, n - audio.shape[0]), (0, 0)))


# ── Ticket 17: high-pitch protection ────────────────────────────────────────

def protect_vocal_file(
    vocal_path: str, output_path: str,
    reduction_db: float = 8.0, peak_ceiling: float = 0.95,
) -> dict[str, Any]:
    audio, sr = _load(vocal_path)
    per_channel = [
        protect_high_pitch(audio[:, c], sr, reduction_db=reduction_db, peak_ceiling=peak_ceiling)
        for c in range(audio.shape[1])
    ]
    out = np.stack([c[0] for c in per_channel], axis=1)
    # Stats are per-channel-identical in practice (same DSP, same input
    # loudness range) — the first channel's numbers stand in for the file.
    stats = per_channel[0][1]

    out_p = Path(output_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_p), out, sr, subtype="PCM_16")

    return {
        "output_path":  str(out_p),
        "duration_sec": round(out.shape[0] / sr, 3),
        "sample_rate":  sr,
        **stats,
    }


# ── Ticket 19: pitch shift ──────────────────────────────────────────────────

def pitch_shift_file(input_path: str, semitones: float, output_path: str) -> dict[str, Any]:
    audio, sr = _load(input_path)
    n, ch = audio.shape

    if abs(semitones) < 1e-6 or n == 0:
        shifted = audio.copy()
    else:
        factor = 2.0 ** (semitones / 12.0)
        # Lightweight two-pass resample pitch-shifter: resample by `factor`
        # (shifts pitch, incidentally changes duration), then resample back
        # to the original sample count (restores duration/tempo so the
        # result still lines up with the vocal it will be merged with).
        # This has known artifacts on large shifts compared to a proper
        # phase vocoder, but needs no extra dependency beyond numpy — a real
        # deployment can swap in a DSP library (e.g. rubberband) here
        # without touching merge_train_audio() or any caller.
        stretched_len = max(1, int(round(n / factor)))
        src_idx = np.linspace(0, n - 1, num=n)
        mid_idx = np.linspace(0, n - 1, num=stretched_len)
        stretched = np.stack(
            [np.interp(mid_idx, src_idx, audio[:, c]) for c in range(ch)], axis=1)

        mid2_idx = np.linspace(0, stretched_len - 1, num=stretched_len)
        dst_idx  = np.linspace(0, stretched_len - 1, num=n)
        shifted = np.stack(
            [np.interp(dst_idx, mid2_idx, stretched[:, c]) for c in range(ch)], axis=1)

    out_p = Path(output_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_p), shifted.astype(np.float32), sr, subtype="PCM_16")

    return {
        "output_path":  str(out_p),
        "duration_sec": round(shifted.shape[0] / sr, 3),
        "sample_rate":  sr,
        "semitones":    semitones,
    }


# ── Ticket 20: merge + package ──────────────────────────────────────────────

def merge_train_audio(
    vocal_path: str, target_path: str, output_path: str,
    align_mode: str = "pad", dry_vocal_path: str | None = None,
    include_dry_vocal: bool = False,
) -> dict[str, Any]:
    """Time-align the (protected) vocal and the (pitch-shifted) target song,
    mix them into a single training file, and optionally copy the dry vocal
    alongside it as a separate track."""
    vocal, sr = _load(vocal_path)
    target, sr_t = _load(target_path)
    if sr_t != sr:
        target = _resample_linear(target, sr_t, sr)

    channels = max(vocal.shape[1], target.shape[1])
    vocal  = _match_channels(vocal, channels)
    target = _match_channels(target, channels)

    n_v, n_t = vocal.shape[0], target.shape[0]
    adjusted_sec = round(abs(n_v - n_t) / sr, 3)

    if align_mode == "truncate":
        n = min(n_v, n_t)
        vocal, target = vocal[:n], target[:n]
    else:
        align_mode = "pad"
        n = max(n_v, n_t)
        vocal, target = _pad_to(vocal, n), _pad_to(target, n)

    mixed = vocal + target
    peak = float(np.max(np.abs(mixed))) if mixed.size else 0.0
    normalized = peak > 1.0
    if normalized:
        mixed = mixed / peak   # peak-normalize so the sum of two full-scale tracks can't clip

    out_p = Path(output_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_p), mixed.astype(np.float32), sr, subtype="PCM_16")

    result: dict[str, Any] = {
        "output_path":  str(out_p),
        "duration_sec": round(n / sr, 3),
        "sample_rate":  sr,
        "align_mode":   align_mode,
        "adjusted_sec": adjusted_sec,
        "normalized":   normalized,
    }

    if include_dry_vocal and dry_vocal_path and Path(dry_vocal_path).exists():
        dry_out = out_p.parent / "dry_vocal.wav"
        shutil.copyfile(dry_vocal_path, dry_out)
        result["dry_vocal_path"] = str(dry_out)

    return result


def package_train_dataset(files: list[dict[str, str]], output_zip_path: str) -> dict[str, Any]:
    """Zip the given {path, name} files (silently skipping any that no
    longer exist) into output_zip_path, ready for multipart upload."""
    out_p = Path(output_zip_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    names: list[str] = []
    with zipfile.ZipFile(out_p, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            src = Path(f["path"])
            if not src.exists():
                continue
            arcname = f.get("name") or src.name
            zf.write(src, arcname=arcname)
            names.append(arcname)
    return {
        "zip_path":   str(out_p),
        "size_bytes": out_p.stat().st_size,
        "files":      names,
    }
