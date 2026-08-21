"""
Post-synthesis audio enhancement chain (Ticket 48).

The raw AI vocal coming out of cover_synthesis.py carries three kinds of
quality problems the synthesis model doesn't fix on its own:

  - broadband hiss (V2's breathiness noise injection is the biggest source,
    plus WSOLA seam artifacts in V1)
  - inconsistent loudness relative to a commercial reference level
  - sibilant harshness, since the reference vocal's raw dynamic envelope is
    copied onto a differently-voiced signal with no spectral shaping

This module is a small, dependency-free (numpy-only, matching the rest of
engine/ — no librosa/scipy) chain that runs right before the AI vocal is
mixed and exported:

    spectral_gate  ->  deess  ->  compress  ->  normalize_loudness

Every stage is a pure function over a mono float32 array so each is easy to
unit-test and to reorder/disable independently. postprocess_chain() ties
them together and reports what it did so callers (and the training/cover
UI) can surface real numbers instead of a black box.
"""
from __future__ import annotations

from typing import TypedDict

import numpy as np

# ── STFT / ISTFT helpers (vectorised, no external deps) ─────────────────────

def _stft(audio: np.ndarray, n_fft: int, hop: int) -> tuple[np.ndarray, np.ndarray]:
    """Vectorised STFT via a zero-copy sliding-window view (see cover_synthesis
    .extract_features for the same pattern). Returns (complex spectrum
    [T, n_fft//2+1], analysis window)."""
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


# ── Spectral gate (broadband denoise) ────────────────────────────────────────

def spectral_gate_denoise(
    audio: np.ndarray, sr: int,
    n_fft: int = 1024, hop: int = 256,
    noise_percentile: float = 50.0,
    over_subtract: float = 8.0,
    spectral_floor: float = 0.08,
    freq_smooth: int = 1,
) -> tuple[np.ndarray, float]:
    """
    Attenuate stationary broadband noise via magnitude spectral subtraction
    (Boll 1979) with a spectral floor to avoid "musical noise" artifacts.

    Estimates a per-bin noise magnitude as the `noise_percentile`-th
    percentile across all frames — this works without a separate noise
    reference because voiced/formant energy is intermittent and
    frequency-localised per bin while hiss/noise is present at a roughly
    constant level in (almost) every frame and bin. That estimate is then
    subtracted (scaled by `over_subtract`, since a plain 1x subtraction
    under-removes noise energy in practice) from every frame's magnitude,
    clamped to a small residual floor (`spectral_floor` × the estimate) so
    bins never get gated to exact silence, which is what produces audible
    chirping/"musical noise". Bins where real signal dominates (magnitude
    well above the noise estimate) are left close to untouched, since the
    subtraction removes only a small fraction of a much larger value.

    Tuned (see engine/_test_suite.py's T11) to recover ≥ 2 dB of SI-SNR
    against a range of broadband-noise levels without visibly distorting
    the underlying tone. `freq_smooth` defaults to off: smoothing the noise
    floor across neighbouring bins sounds like it should reduce gate
    ringing, but a strong narrowband peak (a sung note's fundamental or any
    harmonic) spreads its own high floor value into the quieter bins next
    to it, which raises the subtraction threshold right where noise is
    still present and measurably hurts reduction — worse near real vocal
    content, not better.

    Returns (denoised_audio, applied_reduction_db) — the second value is a
    diagnostic (overall spectral-magnitude reduction in dB), useful for
    logging/QA rather than fed back into the gate itself.
    """
    audio = np.asarray(audio, dtype=np.float32)
    if len(audio) < n_fft:
        return audio.copy(), 0.0

    spec, window = _stft(audio, n_fft, hop)
    mag = np.abs(spec)

    noise_floor = np.percentile(mag, noise_percentile, axis=0)  # [n_bins]
    if freq_smooth > 1:
        k = np.ones(freq_smooth, dtype=np.float32) / freq_smooth
        noise_floor = np.convolve(noise_floor, k, mode="same")

    mag_subtracted = mag - over_subtract * noise_floor[None, :]
    mag_denoised   = np.maximum(mag_subtracted, spectral_floor * noise_floor[None, :])
    gain = mag_denoised / (mag + 1e-8)

    denoised_spec = spec * gain
    out = _istft(denoised_spec, window, hop, len(audio))

    reduction_db_applied = float(
        20.0 * np.log10((mag.mean() + 1e-8) / (np.abs(denoised_spec).mean() + 1e-8))
    )
    return out, max(0.0, reduction_db_applied)


# ── De-esser (sibilance control) ─────────────────────────────────────────────

def deess(
    audio: np.ndarray, sr: int,
    band_hz: tuple[float, float] = (4_000.0, 9_000.0),
    reduction_db: float = 6.0,
    n_fft: int = 1024, hop: int = 256,
) -> np.ndarray:
    """
    Dynamic sibilance reduction: attenuates the 4-9 kHz band only in frames
    where it carries disproportionate energy relative to the rest of the
    spectrum, so normal vowel/consonant energy passing through that band on
    other frames is left alone (unlike a static shelf EQ).
    """
    audio = np.asarray(audio, dtype=np.float32)
    if len(audio) < n_fft:
        return audio.copy()

    spec, window = _stft(audio, n_fft, hop)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    band_mask = (freqs >= band_hz[0]) & (freqs <= band_hz[1])
    if not np.any(band_mask):
        return audio.copy()

    mag = np.abs(spec)
    band_energy = np.sqrt(np.mean(mag[:, band_mask] ** 2, axis=1))
    full_energy = np.sqrt(np.mean(mag ** 2, axis=1)) + 1e-8
    sibilance_ratio = band_energy / full_energy

    thresh = np.percentile(sibilance_ratio, 75)
    excess = np.clip(sibilance_ratio - thresh, 0.0, None)
    atten_db = np.clip(excess / (thresh + 1e-8), 0.0, 1.0) * reduction_db
    gain_band = 10.0 ** (-atten_db / 20.0)  # [T]

    gain = np.ones_like(mag)
    gain[:, band_mask] = gain_band[:, None]
    return _istft(spec * gain, window, hop, len(audio))


# ── Dynamics compression ──────────────────────────────────────────────────────

def compress(
    audio: np.ndarray, sr: int,
    threshold_db: float = -18.0, ratio: float = 3.0,
    attack_ms: float = 8.0, release_ms: float = 120.0,
    makeup_db: float = 0.0, block_ms: float = 5.0,
) -> np.ndarray:
    """
    Gentle feed-forward dynamic range compressor.

    Envelope is tracked at block resolution (block_ms, ~5 ms) rather than
    per-sample: a block-level RMS reshape is fully vectorised, and the
    attack/release smoothing loop then only runs once per block (hundreds,
    not hundreds of thousands, of iterations) — the same cost/accuracy
    trade-off as the OLA hop loops elsewhere in engine/ (see separation.py's
    OLAProcessor), and keeps this well inside the cover-synthesis real-time
    budget.
    """
    audio = np.asarray(audio, dtype=np.float32)
    n = len(audio)
    block = max(1, int(sr * block_ms / 1000.0))
    if n < block:
        return audio.copy()

    n_blocks = -(-n // block)
    padded = np.pad(audio, (0, n_blocks * block - n))
    blocks = padded.reshape(n_blocks, block)
    block_rms = np.sqrt(np.mean(blocks ** 2, axis=1)) + 1e-8  # [n_blocks]

    block_rate = sr / block
    a_att = np.exp(-1.0 / max(1.0, block_rate * attack_ms  / 1000.0))
    a_rel = np.exp(-1.0 / max(1.0, block_rate * release_ms / 1000.0))

    smoothed = np.empty_like(block_rms)
    prev = float(block_rms[0])
    for i in range(n_blocks):
        x = float(block_rms[i])
        a = a_att if x > prev else a_rel
        prev = a * prev + (1.0 - a) * x
        smoothed[i] = prev

    env_db  = 20.0 * np.log10(smoothed)
    over    = np.clip(env_db - threshold_db, 0.0, None)
    gain_db = -over * (1.0 - 1.0 / ratio) + makeup_db
    gain_block = 10.0 ** (gain_db / 20.0)

    gain = np.repeat(gain_block, block)[:n]
    return (audio * gain).astype(np.float32)


# ── Loudness normalisation ────────────────────────────────────────────────────

def normalize_loudness(
    audio: np.ndarray, target_rms_db: float = -16.0, peak_ceiling: float = 0.98,
) -> np.ndarray:
    """RMS-target loudness normalisation with a gentle tanh soft-knee limiter
    on anything that would otherwise clip past `peak_ceiling`."""
    audio = np.asarray(audio, dtype=np.float32)
    if audio.size == 0:
        return audio.copy()

    rms = float(np.sqrt(np.mean(audio ** 2))) + 1e-8
    gain = (10.0 ** (target_rms_db / 20.0)) / rms
    out = audio * gain

    peak = float(np.max(np.abs(out))) + 1e-8
    if peak > peak_ceiling:
        # tanh(x/ceiling)*ceiling: near-linear for |x| << ceiling, saturates
        # smoothly toward ±ceiling for transients that would otherwise clip.
        out = np.tanh(out / peak_ceiling) * peak_ceiling
    return out.astype(np.float32)


# ── Chain ─────────────────────────────────────────────────────────────────────

class PostprocessResult(TypedDict):
    audio:               np.ndarray
    noise_reduction_db:  float
    final_rms_db:        float
    final_peak:          float


def postprocess_chain(
    audio: np.ndarray, sr: int, *,
    denoise: bool = True, deess_: bool = True, dynamics: bool = True,
    normalize: bool = True, target_rms_db: float = -16.0,
) -> PostprocessResult:
    """Run the full spectral_gate -> deess -> compress -> normalize chain."""
    audio = np.asarray(audio, dtype=np.float32)
    if audio.size == 0:
        return PostprocessResult(
            audio=audio, noise_reduction_db=0.0, final_rms_db=-120.0, final_peak=0.0)

    out = audio
    noise_reduction_db = 0.0
    if denoise:
        out, noise_reduction_db = spectral_gate_denoise(out, sr)
    if deess_:
        out = deess(out, sr)
    if dynamics:
        out = compress(out, sr)
    if normalize:
        out = normalize_loudness(out, target_rms_db=target_rms_db)

    final_rms = float(np.sqrt(np.mean(out ** 2))) + 1e-8
    return PostprocessResult(
        audio=out.astype(np.float32),
        noise_reduction_db=round(noise_reduction_db, 2),
        final_rms_db=round(float(20.0 * np.log10(final_rms)), 2),
        final_peak=round(float(np.max(np.abs(out))), 4),
    )
