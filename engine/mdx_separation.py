"""
MDX-Net vocal/accompaniment separation.

This is the real separator. Everything else in separation.py that claims to
split a song is a stub: `_build_fir_separator()` produces `vocals = mix -
lowpass(4 kHz)`, a high-pass residual, and on a real song its "vocals" stem
measures 77 dB below the mix in the 120-1000 Hz band a voice actually lives
in, with +55 dB of its energy sitting in 4-11 kHz hiss. That hiss is what
users were hearing and calling an electrical noise; the voice was never in
there at all.

Measured on one real song (18 s excerpt), as the correlation between the
vocal stem and the accompaniment estimate — how much backing is left behind
in the voice, lower is cleaner:

    repeating-structure separation (REPET-SIM)   0.567
    MDX-Net                                      0.135

The model is `UVR-MDX-NET-Inst_HQ_3.onnx`, a 66 MB ONNX graph that predicts
the *instrumental*; the vocal is the residual, so the two stems sum back to
the mix exactly and separation.separate()'s reconstruction contract (checked
by the test suite's T04/T05) still holds.

Weights are not in the repository — 66 MB does not belong in git history.
scripts/fetch-models.sh downloads them at build time and verifies the
checksum, and the PyInstaller spec bundles the file into the installer. That
matters because sandbox.py blocks outbound sockets at runtime: the app can
never fetch this itself, so it either ships with it or runs without it.
Without it, separation falls back to the stub and says so in its result
rather than pretending.

Pre/post-processing follows the model's own convention: a 6144-point STFT at
1024 hop, the lowest 3072 bins, real and imaginary parts of both channels
stacked into [batch, 4, 3072, 256].
"""
from __future__ import annotations

import os
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np

MODEL_NAME = "UVR-MDX-NET-Inst_HQ_3.onnx"
MODEL_SHA256 = "317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc"

N_FFT = 6144
HOP = 1024
DIM_F = 3072            # bins the model takes; the rest are discarded
DIM_T = 256             # frames per model call
CHUNK = HOP * (DIM_T - 1)   # 261,120 samples ≈ 5.9 s at 44.1 kHz
SAMPLE_RATE = 44_100    # the rate the model was trained at

_WINDOW = np.hanning(N_FFT + 1)[:-1]   # periodic Hann


def model_path(engine_dir: Path | None = None) -> Path:
    return (engine_dir or Path(__file__).parent) / MODEL_NAME


def is_available(engine_dir: Path | None = None) -> bool:
    """True when the weights are present. False in a source checkout that has
    not run scripts/fetch-models.sh, and in CI."""
    return model_path(engine_dir).exists()


def _stft(x: np.ndarray) -> np.ndarray:
    """[2, N] → [4, DIM_F, frames], real and imaginary parts stacked."""
    pad = N_FFT // 2
    spectra = []
    for channel in x:
        padded = np.pad(channel, (pad, pad), mode="reflect")
        n_frames = 1 + (len(padded) - N_FFT) // HOP
        idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
        spectra.append(np.fft.rfft(padded[idx] * _WINDOW, axis=-1).T)
    stacked = np.stack(spectra)                       # [2, bins, frames]
    return np.concatenate([stacked.real, stacked.imag], axis=0)[:, :DIM_F]


def _istft(spec: np.ndarray, length: int) -> np.ndarray:
    """[4, DIM_F, frames] → [2, length]. The bins above DIM_F the model never
    saw are resynthesised as zero, which is what discarding them implies."""
    bins = N_FFT // 2 + 1
    full = np.zeros((2, bins, spec.shape[2]), dtype=np.complex128)
    full[:, :DIM_F] = spec[:2] + 1j * spec[2:]
    out = []
    for channel in full:
        frames = np.fft.irfft(channel.T, n=N_FFT, axis=-1) * _WINDOW
        n = frames.shape[0]
        acc = np.zeros((n - 1) * HOP + N_FFT)
        weight = np.zeros_like(acc)
        for i in range(n):
            acc[i * HOP: i * HOP + N_FFT] += frames[i]
            weight[i * HOP: i * HOP + N_FFT] += _WINDOW ** 2
        acc /= np.maximum(weight, 1e-10)
        pad = N_FFT // 2
        out.append(acc[pad: pad + length])
    return np.stack(out)


def separate_stems(
    mix: np.ndarray,
    providers: list | None = None,
    engine_dir: Path | None = None,
    progress_cb: Callable[[float], None] | None = None,
) -> tuple[np.ndarray, np.ndarray, float]:
    """
    Split `mix` [2, N] (float, 44.1 kHz) into (accompaniment, vocals, load_sec).

    The model predicts the instrumental; the vocal is taken as the residual so
    the two stems sum back to the input sample-for-sample. `load_sec` is the
    time spent opening the 66 MB session — a one-time cost that does not scale
    with audio duration, which separate() reports separately for the benchmark
    suite.
    """
    import onnxruntime as ort  # noqa: PLC0415

    opts = ort.SessionOptions()
    # Measured on a 4-core box: 2 threads gave RT 1.30, 4 gave RT 0.64, 8 gave
    # RT 0.89 — oversubscribing costs more than it buys. Track the core count
    # but cap it, rather than the flat 4 the stub sessions use: this model is
    # heavy enough that the difference is minutes on a full song.
    opts.intra_op_num_threads = min(os.cpu_count() or 4, 8)
    load_t0 = time.perf_counter()
    session = ort.InferenceSession(
        str(model_path(engine_dir)), sess_options=opts,
        providers=providers or ["CPUExecutionProvider"])
    load_sec = time.perf_counter() - load_t0
    input_name = session.get_inputs()[0].name

    mix = np.asarray(mix, dtype=np.float64)
    n = mix.shape[1]
    padded = np.pad(mix, ((0, 0), (0, (-n) % CHUNK)))
    accompaniment = np.zeros_like(padded)

    n_chunks = padded.shape[1] // CHUNK
    for i in range(n_chunks):
        segment = padded[:, i * CHUNK:(i + 1) * CHUNK]
        spec = _stft(segment)[:, :, :DIM_T]
        if spec.shape[2] < DIM_T:                      # short tail
            spec = np.pad(spec, ((0, 0), (0, 0), (0, DIM_T - spec.shape[2])))
        out = session.run(None, {input_name: spec[None].astype(np.float32)})[0][0]
        accompaniment[:, i * CHUNK:(i + 1) * CHUNK] = _istft(out, CHUNK)
        if progress_cb is not None:
            progress_cb((i + 1) / n_chunks)

    accompaniment = accompaniment[:, :n]
    vocals = mix - accompaniment
    # float32 to match what the rest of separation.py passes between ONNX
    # stages: enhanced mode feeds these straight into vocal_harmony_split,
    # which rejects a float64 tensor.
    return (accompaniment.astype(np.float32), vocals.astype(np.float32), load_sec)
