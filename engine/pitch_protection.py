"""
High-pitch protection / forced auto-tune (Ticket 17, 强制修音).

The UI's threshold is fixed at D#4 (MIDI note 63, ~311.13 Hz — "高音保护起点
为D#4"). Any sustained note whose detected pitch rises above that gets
pulled back down to (approximately) D#4; everything at or below the
threshold passes through untouched. Because the correction targets a flat
threshold rather than a proportional transposition, a melody that climbs
well above D#4 gets flattened onto (near) a single pitch while it's up
there — the "subtle auto-tune / robotic effect" the ticket describes is a
direct consequence of that clamp, not a side effect to engineer away.

Pipeline
--------
  1. STFT the mono signal and track a frame-level pitch contour via
     spectral peak-picking (same lightweight technique
     cover_synthesis.extract_features() uses — engine/ stays numpy-only, no
     librosa/scipy/CREPE, so a dedicated pitch tracker isn't pulled in just
     for this).
  2. Frames above the D#4 threshold are grouped into contiguous runs (small
     gaps closed, blip-length runs dropped — a lone misdetected frame isn't
     a "note"). Each run gets one target pitch ratio from its *median*
     detected frequency, so it's corrected toward D#4 as a whole rather than
     chasing every frame-level jitter in a noisy pitch estimate.
  3. Each run (plus a little surrounding context) is pitch-shifted by that
     ratio using the standard two-stage phase-vocoder recipe — time-stretch
     at constant pitch via phase-vocoder resynthesis, then linear-resample
     back to the original duration, which is what actually moves the pitch
     (the same recipe librosa.effects.pitch_shift uses internally) — and
     crossfaded back into the track with a short raised ramp at each edge
     so the shifted/unshifted boundary doesn't click.
  4. The run spans (not the crossfade padding) are returned as
     [start_sec, end_sec] pairs for the renderer to highlight in red as
     "here 强制修音 fired".
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import TypedDict

import numpy as np
import soundfile as sf

# ── Constants ─────────────────────────────────────────────────────────────

DEFAULT_THRESHOLD_NOTE: int = 63     # D#4 — "高音保护起点为D#4"
N_FFT: int = 1024
HOP:   int = 256                     # 4x overlap → smooth Hann-window OLA
F0_MIN_HZ: float = 80.0              # low end of the pitch search band (bass)
F0_MAX_HZ: float = 1_200.0           # high end (covers well past soprano)

MIN_RUN_SEC:    float = 0.06   # shorter than this isn't a "note" — likely a pitch-tracker blip
MAX_GAP_SEC:    float = 0.05   # bridges brief dips (consonants, vibrato) within one note
CONTEXT_PAD_SEC: float = 0.05  # extra audio grabbed around a run for a clean phase-vocoder analysis
FADE_SEC:       float = 0.015  # crossfade length at each shifted/unshifted boundary


def midi_to_hz(note: float) -> float:
    """12-TET, A4 (MIDI 69) = 440 Hz. midi_to_hz(63) ≈ 311.13 Hz = D#4."""
    return 440.0 * (2.0 ** ((note - 69.0) / 12.0))


# ── STFT / ISTFT ──────────────────────────────────────────────────────────

def _stft(audio: np.ndarray, n_fft: int = N_FFT, hop: int = HOP) -> tuple[np.ndarray, np.ndarray]:
    """Vectorised STFT via a zero-copy sliding-window view. Returns
    (complex spectrum [T, n_fft//2+1], analysis window)."""
    window = np.hanning(n_fft).astype(np.float32)
    pad = n_fft // 2
    padded = np.pad(audio.astype(np.float32), pad)
    n_frames = max(1, (len(padded) - n_fft) // hop + 1)
    frames = np.lib.stride_tricks.sliding_window_view(padded, n_fft)[::hop][:n_frames]
    spec = np.fft.rfft(frames * window, axis=1)
    return spec, window


def _istft(spec: np.ndarray, window: np.ndarray, hop: int, length: int) -> np.ndarray:
    """Overlap-add inverse of _stft; trims/pads the result to `length` samples."""
    n_fft = window.shape[0]
    frames = np.fft.irfft(spec, n=n_fft, axis=1).astype(np.float32) * window
    pad = n_fft // 2
    out_len = (spec.shape[0] - 1) * hop + n_fft
    out  = np.zeros(out_len, dtype=np.float32)
    norm = np.zeros(out_len, dtype=np.float32)
    for i in range(spec.shape[0]):
        s = i * hop
        out[s:s + n_fft]  += frames[i]
        norm[s:s + n_fft] += window ** 2
    mask = norm > 1e-8
    out[mask] /= norm[mask]
    out = out[pad:]
    if len(out) < length:
        out = np.pad(out, (0, length - len(out)))
    return out[:length].astype(np.float32)


# ── Pitch contour ─────────────────────────────────────────────────────────

def _extract_pitch_contour(spec: np.ndarray, sr: int, n_fft: int = N_FFT) -> np.ndarray:
    """
    Frame-level F0 (Hz, 0 for unvoiced) via spectral peak-picking in
    [F0_MIN_HZ, F0_MAX_HZ] — the same lightweight technique
    cover_synthesis.extract_features() uses. It's not as accurate as a
    dedicated tracker (autocorrelation/YIN/CREPE), but it's fully vectorised
    and easily clears the 5s/30s-clip CPU budget, and correction only needs
    to know *which* frames are above the D#4 threshold (runs are then
    corrected from their aggregate median, see apply_high_pitch_protection),
    not a musicology-grade pitch estimate.
    """
    mag = np.abs(spec)
    rms = np.sqrt(np.mean(mag ** 2, axis=1)) + 1e-8

    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    band = (freqs >= F0_MIN_HZ) & (freqs <= F0_MAX_HZ)
    if not np.any(band):
        return np.zeros(spec.shape[0], dtype=np.float32)

    peak_idx = np.argmax(mag[:, band], axis=1)
    f0 = freqs[band][peak_idx]
    voiced = rms > (0.02 * rms.max())
    return np.where(voiced, f0, 0.0).astype(np.float32)


def _find_runs(mask: np.ndarray, min_run_frames: int, max_gap_frames: int) -> list[tuple[int, int]]:
    """
    Groups a per-frame boolean mask into (start_frame, end_frame) runs
    (end exclusive): gaps of up to `max_gap_frames` frames between two
    above-threshold spans are closed (one sustained high note shouldn't
    fracture into several tiny runs over a consonant or a vibrato dip), and
    runs shorter than `min_run_frames` are dropped as pitch-tracker blips
    rather than real notes.
    """
    raw: list[list[int]] = []
    in_run = False
    start = 0
    for i, active in enumerate(mask):
        if active and not in_run:
            start, in_run = i, True
        elif not active and in_run:
            raw.append([start, i])
            in_run = False
    if in_run:
        raw.append([start, len(mask)])

    closed: list[list[int]] = []
    for run in raw:
        if closed and run[0] - closed[-1][1] <= max_gap_frames:
            closed[-1][1] = run[1]
        else:
            closed.append(run)

    return [(s, e) for s, e in closed if (e - s) >= min_run_frames]


# ── Phase-vocoder pitch shift ─────────────────────────────────────────────

def _resample_to_length(audio: np.ndarray, new_length: int) -> np.ndarray:
    """Linear-interpolation resample to an arbitrary target sample count
    (cover_synthesis._resample_mono's technique, generalised from a target
    sample rate to a target length)."""
    if new_length <= 0:
        return np.zeros(0, dtype=np.float32)
    if len(audio) == new_length:
        return audio.astype(np.float32)
    if len(audio) < 2:
        fill = float(audio[0]) if len(audio) else 0.0
        return np.full(new_length, fill, dtype=np.float32)
    src_idx = np.linspace(0, len(audio) - 1, new_length)
    return np.interp(src_idx, np.arange(len(audio)), audio).astype(np.float32)


def _phase_vocoder_stretch(spec: np.ndarray, rate: float, hop: int, n_fft: int) -> np.ndarray:
    """
    Phase-vocoder time-stretch of a complex STFT by `rate`
    (rate > 1 shortens the output, rate < 1 lengthens it; pitch is
    unaffected — this stage only changes duration). Reconstructs each
    output frame's phase by accumulating the bin's *measured* instantaneous
    frequency (from the phase difference between consecutive analysis
    frames) rather than copying analysis phase verbatim, which is what
    keeps the stretched audio's pitch stable regardless of the stretch
    factor. Standard phase-vocoder resynthesis (same algorithm
    librosa.effects.time_stretch / pitch_shift use internally).
    """
    T, n_bins = spec.shape
    if T < 2:
        return spec.copy()

    time_steps = np.arange(0, T, rate, dtype=np.float64)
    padded = np.pad(spec, ((0, 1), (0, 0)), mode="edge")
    mags   = np.abs(padded)
    phases = np.angle(padded)
    phase_advance = 2.0 * np.pi * hop * np.arange(n_bins) / n_fft

    out = np.empty((len(time_steps), n_bins), dtype=np.complex64)
    phase_acc = phases[0].copy()

    for i, t in enumerate(time_steps):
        t0 = int(t)
        frac = t - t0
        mag = (1.0 - frac) * mags[t0] + frac * mags[t0 + 1]

        dphase = phases[t0 + 1] - phases[t0] - phase_advance
        dphase = dphase - 2.0 * np.pi * np.round(dphase / (2.0 * np.pi))  # wrap to (-pi, pi]

        out[i] = mag * np.exp(1j * phase_acc)
        phase_acc = phase_acc + phase_advance + dphase

    return out


def _pitch_shift_segment(segment: np.ndarray, ratio: float,
                         hop: int = HOP, n_fft: int = N_FFT) -> np.ndarray:
    """
    Shifts `segment`'s pitch by `ratio` (< 1 lowers pitch) while keeping its
    length unchanged: phase-vocoder time-stretch to 1/ratio speed (pitch
    unchanged, duration scaled by `ratio`), then linear-resample back out to
    the original length — that resample is what actually moves the pitch,
    by `ratio` (the same two-stage recipe librosa.effects.pitch_shift uses).
    """
    if len(segment) < n_fft or abs(ratio - 1.0) < 1e-4:
        return segment.astype(np.float32).copy()

    spec, window = _stft(segment, n_fft, hop)
    stretched_spec = _phase_vocoder_stretch(spec, rate=1.0 / ratio, hop=hop, n_fft=n_fft)

    stretched_len = max(n_fft, int(round(len(segment) * ratio)))
    stretched = _istft(stretched_spec, window, hop, stretched_len)

    return _resample_to_length(stretched, len(segment))


# ── Public API ────────────────────────────────────────────────────────────

class HighPitchProtectionResult(TypedDict):
    output_path:          str
    sample_rate:           int
    duration_sec:           float
    elapsed_sec:             float
    threshold_note:          int
    threshold_hz:            float
    modified_regions:       list[list[float]]   # [[start_sec, end_sec], ...]
    modified_ratio:          float              # fraction of duration corrected
    max_shift_semitones:     float


def apply_high_pitch_protection(
    audio_path: str | Path,
    threshold_note: int = DEFAULT_THRESHOLD_NOTE,
    output_path: str | Path | None = None,
) -> HighPitchProtectionResult:
    """
    Ticket 17: clamp any sustained note above `threshold_note` (default D#4
    / MIDI 63) down toward that note. Returns the processed WAV's path plus
    `modified_regions` so the UI can highlight the corrected spans in red.
    """
    t0 = time.perf_counter()
    audio_path = Path(audio_path)
    raw, sr = sf.read(str(audio_path), dtype="float32", always_2d=True)
    mono = raw.mean(axis=1).astype(np.float32)
    n_samples = len(mono)

    threshold_hz = float(midi_to_hz(threshold_note))

    if output_path is None:
        output_path = audio_path.parent / f"{audio_path.stem}_protected.wav"
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if n_samples < N_FFT:
        # Too short to analyse in frames — write through unchanged rather
        # than fail; matches spectral_gate_denoise's guard in postprocess.py.
        sf.write(str(output_path), mono, sr, subtype="PCM_16")
        return HighPitchProtectionResult(
            output_path=str(output_path), sample_rate=sr,
            duration_sec=round(n_samples / sr, 3) if sr else 0.0,
            elapsed_sec=round(time.perf_counter() - t0, 4),
            threshold_note=threshold_note, threshold_hz=round(threshold_hz, 2),
            modified_regions=[], modified_ratio=0.0, max_shift_semitones=0.0,
        )

    spec, _window = _stft(mono, N_FFT, HOP)
    f0 = _extract_pitch_contour(spec, sr, N_FFT)
    above = f0 > threshold_hz

    min_run_frames = max(1, round(MIN_RUN_SEC * sr / HOP))
    max_gap_frames = max(1, round(MAX_GAP_SEC * sr / HOP))
    runs = _find_runs(above, min_run_frames, max_gap_frames)

    context  = int(round(CONTEXT_PAD_SEC * sr))
    fade_n   = int(round(FADE_SEC * sr))

    out = mono.copy()
    modified_regions: list[list[float]] = []
    max_shift_semitones = 0.0

    for f_start, f_end in runs:
        run_f0 = f0[f_start:f_end]
        run_f0 = run_f0[run_f0 > threshold_hz]
        if len(run_f0) == 0:
            continue

        # One ratio per run, from its median above-threshold pitch: flattens
        # the note toward D#4 as a whole rather than chasing per-frame
        # jitter in a lightweight (spectral-peak) pitch estimate.
        target_hz = float(np.median(run_f0))
        ratio = float(np.clip(threshold_hz / target_hz, 1e-3, 1.0))
        if ratio >= 0.999:
            continue

        core_start = f_start * HOP
        core_end   = min(n_samples, f_end * HOP + N_FFT)
        seg_start  = max(0, core_start - context)
        seg_end    = min(n_samples, core_end + context)
        segment = mono[seg_start:seg_end]
        if len(segment) < N_FFT:
            continue

        shifted = _pitch_shift_segment(segment, ratio)
        n = min(len(shifted), seg_end - seg_start)

        fade_in  = max(0, min(fade_n, core_start - seg_start, n))
        fade_out = max(0, min(fade_n, seg_end - core_end, n))
        weight = np.ones(n, dtype=np.float32)
        if fade_in > 0:
            weight[:fade_in] = np.linspace(0.0, 1.0, fade_in, dtype=np.float32)
        if fade_out > 0:
            weight[n - fade_out:] = np.linspace(1.0, 0.0, fade_out, dtype=np.float32)

        out[seg_start:seg_start + n] = (
            out[seg_start:seg_start + n] * (1.0 - weight) + shifted[:n] * weight
        )

        region_end_sec = min(n_samples, f_end * HOP) / sr
        modified_regions.append([round(f_start * HOP / sr, 3), round(region_end_sec, 3)])
        max_shift_semitones = max(max_shift_semitones, float(12.0 * np.log2(target_hz / threshold_hz)))

    peak = float(np.max(np.abs(out))) + 1e-8
    if peak > 0.99:
        out = (out / peak * 0.99).astype(np.float32)

    sf.write(str(output_path), out, sr, subtype="PCM_16")

    total_seconds    = n_samples / sr if sr else 0.0
    modified_seconds = sum(e - s for s, e in modified_regions)

    return HighPitchProtectionResult(
        output_path=str(output_path),
        sample_rate=sr,
        duration_sec=round(total_seconds, 3),
        elapsed_sec=round(time.perf_counter() - t0, 4),
        threshold_note=threshold_note,
        threshold_hz=round(threshold_hz, 2),
        modified_regions=modified_regions,
        modified_ratio=round(min(1.0, modified_seconds / total_seconds), 4) if total_seconds else 0.0,
        max_shift_semitones=round(max_shift_semitones, 2),
    )
