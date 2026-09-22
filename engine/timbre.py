"""
Spectral-envelope timbre transfer.

What the cover flow used to do: synthesise an "AI voice" from nothing — a pure
sine at the reference's f0, pushed through a near-identity matrix, with the
phoneme sequence hardcoded to the single vowel "a" (`["a","e","i","o","u"][0:1]
* n_phon`). A whole song came out as one sustained "aaaa" drone, which is what
users reported as noise. Thirty minutes of training could not touch it: the
phonemes were fixed, the excitation was a sine, and the model was two
near-identity linear layers.

What it does now: keep the *reference* vocal as the excitation and move only
its timbre. A voice splits, to a useful approximation, into

    spectrum  =  excitation  ×  spectral envelope

where the excitation carries pitch, timing, consonants and the words, and the
envelope carries who is singing. Replacing the envelope and keeping the
excitation gives real lyrics and real diction in a different voice, which is
the "usable first, resemblance second" order this was asked for.

Honest ceiling: a single average envelope per speaker is the crudest form of
voice conversion. It shifts the voice audibly — it will not pass for the
target singer the way a learned conversion model does. Anything that close
needs a neural converter, which does not fit this product's requirement that
training run on a CPU.

The envelope is a cepstrally-smoothed magnitude spectrum: take log|X|, keep
the lowest few cepstral coefficients, exponentiate. Low quefrency is the
resonance structure of the vocal tract; the harmonics the liftering discards
are exactly the pitch information we want to keep in the excitation instead.
"""
from __future__ import annotations

import numpy as np

# How much of the cepstrum to keep, as a quefrency in seconds rather than a
# coefficient count. Cepstral index n is a period of n/sr seconds, so a fixed
# count means a different smoothing at every sample rate: 40 coefficients
# resolve down to 1.8 ms at 22.05 kHz but only 0.9 ms at 44.1 kHz. Envelopes
# here are *learned* at 22.05 kHz and *applied* at 44.1 kHz, so a count made
# the source envelope twice as coarse as the target it was being divided out
# against, and the transfer imposed detail it had never removed — measured, it
# pushed the converted vocal to 1.53 from the target where the untouched
# reference sat at 1.46.
#
# 1.8 ms sits below any singing pitch period (a 550 Hz fundamental is 1.8 ms,
# and voices go lower), so the lifter follows vocal-tract resonances without
# tracking individual harmonics. Raising it copies the source's pitch into the
# "envelope" and the transfer stops changing anything.
LIFTER_SEC: float = 1.8e-3


def cepstrum_order(sr: int) -> int:
    """Coefficients that LIFTER_SEC comes to at this sample rate."""
    return max(2, round(LIFTER_SEC * sr))


# The order at the rate envelopes are learned at, kept as the default so the
# existing signatures still mean what they did.
N_CEPSTRUM: int = 40

# How far to move the reference towards the target, as an exponent blend.
# 0.0 is a no-op; 1.0 replaces the envelope outright.
#
# Swept end to end against a target whose timbre sat 2.90 from the reference,
# with a same-singer measurement floor of 0.12 (third-octave log-spectrum
# distance, 350 Hz - 8 kHz):
#
#   strength   → target   diction   vowel movement
#     0.00        2.85      1.00        100%
#     0.50        1.47      0.97         74%
#     0.75        0.88      0.97         67%
#     1.00        0.37      0.97         67%
#
# Resemblance keeps improving to 1.0 and diction never suffers, so the choice
# is not about those. It is about what happens when the learned envelope is
# wrong — a noisy upload, or residual accompaniment in the training material.
# At 1.0 the reference's own colour is gone and the output is whatever the
# envelope says; at 0.75 a quarter of the real voice survives and a bad
# envelope degrades rather than destroys. That is the "usable first,
# resemblance second" order this was built to, and 0.75 still closes 70% of
# the distance to the target.
DEFAULT_STRENGTH: float = 0.75

_EPS = 1e-8


def spectral_envelope(mag: np.ndarray, n_cepstrum: int = N_CEPSTRUM) -> np.ndarray:
    """Cepstrally-smoothed envelope of a magnitude spectrogram [bins, frames]."""
    log_mag = np.log(np.asarray(mag, dtype=np.float64) + _EPS)
    cepstrum = np.fft.irfft(log_mag, axis=0)
    cepstrum[n_cepstrum:-n_cepstrum or None] = 0.0
    return np.exp(np.fft.rfft(cepstrum, n=mag.shape[0] * 2 - 2, axis=0).real)


def average_envelope(mag: np.ndarray, n_cepstrum: int = N_CEPSTRUM) -> np.ndarray:
    """One envelope summarising a whole recording, as [bins].

    Averaged in the log domain and weighted by frame energy: a mean of linear
    magnitudes is dominated by the loudest frames, and silence between phrases
    would otherwise pull the average towards the noise floor rather than
    towards the voice.
    """
    env = spectral_envelope(mag, n_cepstrum)
    weight = np.asarray(mag, dtype=np.float64).sum(axis=0)
    if weight.sum() <= _EPS:
        return np.ones(mag.shape[0], dtype=np.float64)
    weight = weight / weight.sum()
    return np.exp((np.log(env + _EPS) * weight[None, :]).sum(axis=1))


def _normalise(env: np.ndarray) -> np.ndarray:
    """Remove overall level so a transfer changes colour, not loudness.

    A spectrogram is normalised per frame, not globally: one geometric mean
    across every frame would let a loud phrase set the level for a quiet one
    and reintroduce as gain exactly the dynamics this is supposed to leave
    alone.
    """
    env = np.asarray(env, dtype=np.float64)
    gm = np.exp(np.mean(np.log(env + _EPS), axis=0, keepdims=True))
    return env / (gm + _EPS)


def transfer(
    mag: np.ndarray,
    target_env: np.ndarray,
    strength: float = DEFAULT_STRENGTH,
    n_cepstrum: int = N_CEPSTRUM,
) -> np.ndarray:
    """
    Re-colour a magnitude spectrogram towards `target_env`.

    mag         [bins, frames] magnitudes of the reference voice
    target_env  [bins] the target's average envelope
    strength    0 = unchanged, 1 = the target's envelope outright

    The excitation — mag divided by its own envelope — is untouched, so pitch,
    timing, consonants and the words all survive.
    """
    if strength <= 0.0:
        return np.asarray(mag, dtype=np.float64)

    mag = np.asarray(mag, dtype=np.float64)
    source_env = spectral_envelope(mag, n_cepstrum)
    excitation = mag / (source_env + _EPS)

    target = _normalise(np.asarray(target_env, dtype=np.float64))[:, None]
    source = _normalise(source_env)

    # Geometric blend: in the log domain this is a straight interpolation
    # between the two envelopes, which keeps the result a plausible envelope
    # instead of the ringing a linear mix of two log-spectra produces.
    blended = source ** (1.0 - strength) * target ** strength
    return excitation * blended


def envelope_from_audio(
    audio: np.ndarray, n_fft: int, hop: int, n_cepstrum: int = N_CEPSTRUM,
) -> np.ndarray:
    """Average envelope of a mono signal, as [n_fft // 2 + 1]."""
    audio = np.asarray(audio, dtype=np.float64)
    if len(audio) < n_fft:
        audio = np.pad(audio, (0, n_fft - len(audio)))
    window = np.hanning(n_fft + 1)[:-1]
    n_frames = 1 + (len(audio) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n_frames)[:, None]
    mag = np.abs(np.fft.rfft(audio[idx] * window, axis=-1)).T
    return average_envelope(mag, n_cepstrum)


def resample_envelope(env: np.ndarray, n_bins: int,
                      src_sr: int, dst_sr: int) -> np.ndarray:
    """Move an envelope onto a different FFT size *and* sample rate.

    Both rates are required, and that is the whole point. Envelopes are
    learned at the training rate (22.05 kHz, Nyquist 11 kHz) and applied at
    the cover rate (44.1 kHz, Nyquist 22 kHz), so interpolating by normalised
    bin index maps 0-11 kHz onto 0-22 kHz and moves every formant up an
    octave: a 700 Hz first formant lands at 1400 Hz and the voice is recoloured
    into something that resembles neither singer. Measured that way the
    converted vocal sat 3.04 from the target against a 0.86 baseline, i.e.
    further from the target than the untouched reference was.

    Interpolating against absolute frequency keeps the resonances where they
    belong. Bins above the learned Nyquist have no measurement behind them and
    hold the last value, which flattens rather than invents.
    """
    env = np.asarray(env, dtype=np.float64)
    src_hz = np.linspace(0.0, src_sr / 2.0, len(env))
    dst_hz = np.linspace(0.0, dst_sr / 2.0, n_bins)
    return np.interp(dst_hz, src_hz, env, left=env[0], right=env[-1])
