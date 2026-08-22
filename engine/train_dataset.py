"""
Merge Audio & Upload Training Dataset — Ticket 20.

Both of this ticket's prerequisites already ship elsewhere: Ticket 17's
high-pitch protection as engine/pitch_protection.py + main.py's
apply_high_pitch_protection, and Ticket 19's pitch shift as
engine/pitch_tools.py + main.py's pitch_shift. This module's merge step
just consumes those two steps' output paths.

  - merge_train_audio(): time-aligns the (high-pitch-protected) vocal and
    the (pitch-shifted) target song (pad-to-longest or truncate-to-shortest),
    mixes them into merged_train.wav, and optionally copies a dry-vocal
    track alongside it.
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
