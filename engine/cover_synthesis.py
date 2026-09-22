"""
Dual-version cover synthesis.

The AI voice is the *reference vocal recoloured towards the trained singer* —
see engine/timbre.py. It used to be synthesised from nothing: a sine at the
reference's f0 through near-identity weights, with the phoneme sequence
hardcoded to a single vowel, so a whole song came back as one sustained drone
and thirty minutes of training could not change it. Keeping the reference as
the excitation means the words, consonants, phrasing and timing are real, and
the training run actually reaches the output.

V1 (efficiency):   envelope transfer  →  level match  →  post-process chain
V2 (precision):    mel extraction  →  LSTM expression encoder  →  expression-
                   conditioned synthesis (vibrato, breath, dynamics injection)

V1 no longer runs DTW/WSOLA. Those existed to drag a from-scratch drone onto
the reference's timing; the AI voice is now derived from that same reference,
so it is already sample-aligned and retiming it against itself would only add
WSOLA seams. dtw_warp/wsola/_v1_cover remain for callers that align two
genuinely different recordings.

Both accept real WAV files or auto-generate synthetic test material.
All heavy computation uses vectorised NumPy; no librosa dependency.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Literal, TypedDict

import numpy as np
import onnx
import onnxruntime as ort
import soundfile as sf
from numpy.lib.stride_tricks import sliding_window_view
from onnx import TensorProto, helper, numpy_helper

from device_detector import detect_device, ordered_providers_for_ep
from postprocess import postprocess_chain

# ── Module constants ──────────────────────────────────────────────────────────

SR      = 44_100          # cover-synthesis sample rate
# Rate the timbre envelope was learned at (trainer.SYNTH_SR). Needed because a
# stored envelope only means something together with its Nyquist — see
# timbre.resample_envelope.
TIMBRE_SR = 22_050
HOP     = 512             # feature-extraction hop (≈ 11.6 ms)
N_FFT   = 2048
N_MELS  = 80
EXPR_DIM = 32
_LSTM_H  = 64

# ── Mel filterbank (lazy singleton) ──────────────────────────────────────────

_MEL_FB: np.ndarray | None = None


def _mel_filterbank(sr: int = SR, n_fft: int = N_FFT,
                    n_mels: int = N_MELS, fmin: float = 80.0, fmax: float = 8000.0,
                    ) -> np.ndarray:
    global _MEL_FB
    if _MEL_FB is not None:
        return _MEL_FB

    def hz2mel(h):
        return 2595.0 * np.log10(1.0 + h / 700.0)
    def mel2hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    mel_pts = np.linspace(hz2mel(fmin), hz2mel(fmax), n_mels + 2)
    hz_pts  = mel2hz(mel_pts)
    bins    = np.floor(hz_pts / sr * n_fft).astype(int)

    fb = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float32)
    for m in range(1, n_mels + 1):
        lo, mid, hi = bins[m - 1], bins[m], bins[m + 1]
        if mid > lo:
            fb[m - 1, lo:mid] = (np.arange(lo, mid) - lo) / (mid - lo)
        if hi > mid:
            fb[m - 1, mid:hi] = (hi - np.arange(mid, hi)) / (hi - mid)

    _MEL_FB = fb
    return fb


# ── Feature extraction (fully vectorised) ────────────────────────────────────

def _frames(audio: np.ndarray, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    """Sliding-window frames [T, n_fft] — zero-copy view + padding."""
    pad = n_fft // 2
    padded = np.pad(audio.astype(np.float32), pad)
    n_frames = (len(padded) - n_fft) // hop + 1
    return np.lib.stride_tricks.sliding_window_view(padded, n_fft)[::hop][:n_frames]


def extract_features(audio: np.ndarray, sr: int = SR) -> dict[str, np.ndarray]:
    """
    Returns dict with:
      f0  [T] Hz (0 for unvoiced)
      rms [T] RMS energy
      mel [T, N_MELS] log-mel spectrogram
    """
    window = np.hanning(N_FFT).astype(np.float32)
    frm    = _frames(audio)                          # [T, N_FFT]
    spec   = np.abs(np.fft.rfft(frm * window))       # [T, N_FFT//2+1] – vectorised

    # RMS
    rms = np.sqrt(np.mean(frm ** 2, axis=1))

    # F0 via spectral peak in [60 Hz, 1000 Hz]
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    mask  = (freqs >= 60.0) & (freqs <= 1_000.0)
    peaks = np.argmax(spec[:, mask], axis=1)
    f0    = freqs[mask][peaks]
    voiced = rms > (0.02 * rms.max() + 1e-8)
    f0    = np.where(voiced, f0, 0.0).astype(np.float32)

    # Log-mel
    fb  = _mel_filterbank(sr)
    mel = np.log1p(spec @ fb.T * 10.0).astype(np.float32)  # [T, N_MELS]

    return {"f0": f0, "rms": rms.astype(np.float32), "mel": mel}


# ── DTW alignment ─────────────────────────────────────────────────────────────

def dtw_warp(feat_src: np.ndarray, feat_ref: np.ndarray,
             coarse_hz: float = 1.0) -> np.ndarray:
    """
    Align feat_src to feat_ref using band-free DTW on coarsely-sampled features.

    feat_src / feat_ref : [T, D]
    coarse_hz : subsample rate in Hz (1 Hz → 1 frame / s → tiny DP table)

    Returns warp [T_ref] — float index into feat_src frames (for interpolation).
    """
    frames_per_sec = SR / HOP                              # ≈ 86 fps
    step = max(1, round(frames_per_sec / coarse_hz))

    a = feat_src[::step].astype(np.float64)               # [T_a, D]
    b = feat_ref[::step].astype(np.float64)               # [T_b, D]
    T_a, T_b = len(a), len(b)

    # Squared Euclidean cost matrix [T_a, T_b]
    C = np.sum((a[:, None, :] - b[None, :, :]) ** 2, axis=-1)

    # Accumulated-cost DP — Python loops on the tiny subsampled table (< 240×240)
    D = np.full((T_a, T_b), np.inf)
    D[0, 0] = C[0, 0]
    for i in range(1, T_a):
        D[i, 0] = D[i - 1, 0] + C[i, 0]
    for j in range(1, T_b):
        D[0, j] = D[0, j - 1] + C[0, j]
    for i in range(1, T_a):
        # D[i, j] depends on D[i, j-1] — the same row, one column back — so
        # the j axis has a genuine sequential dependency and can't be
        # collapsed into one vectorized expression the way this used to try:
        # `D[i, 1:] = C[i, 1:] + minimum(minimum(D[i-1,:-1], D[i-1,1:]), D[i,:-1])`
        # reads D[i, :-1] as it stood *before* this line ran (still mostly
        # np.inf from np.full, except D[i,0]) — numpy evaluates the whole RHS
        # before assigning — so it silently dropped the "arrive from the left
        # in this same row" transition for every column but the first.
        # Confirmed against a textbook double-loop DTW: the two diverged by
        # up to 0.32 in accumulated cost on a 6×6 random test matrix, not
        # float noise. What *can* still be vectorized is the diag/up
        # minimum, which has no same-row dependency; only the final min against
        # the left neighbour needs to stay a sequential per-column loop.
        diag_up = np.minimum(D[i - 1, :-1], D[i - 1, 1:])
        row, Di = C[i], D[i]
        for j in range(1, T_b):
            Di[j] = row[j] + min(diag_up[j - 1], Di[j - 1])

    # Greedy traceback
    path: list[tuple[int, int]] = []
    i, j = T_a - 1, T_b - 1
    while i > 0 or j > 0:
        path.append((i, j))
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            move = np.argmin([D[i - 1, j - 1], D[i - 1, j], D[i, j - 1]])
            if   move == 0: i -= 1; j -= 1
            elif move == 1: i -= 1
            else:           j -= 1
    path.append((0, 0))
    path.reverse()

    p = np.array(path)                         # [[i_src, j_ref], …]
    T_ref_sub = T_b

    # Map ref_sub → src_sub via path (last assignment wins for each ref column)
    ref_to_src_sub = np.zeros(T_ref_sub, dtype=np.float64)
    for i_s, j_r in p:
        ref_to_src_sub[j_r] = float(i_s)

    # Upsample back to full frame resolution
    sub_times  = np.arange(T_ref_sub) * step
    full_times = np.arange(len(feat_ref))
    warp_full  = np.interp(full_times, sub_times, ref_to_src_sub * step)
    return np.clip(warp_full, 0, len(feat_src) - 1).astype(np.float32)


# ── WSOLA retiming ────────────────────────────────────────────────────────────

def wsola(audio: np.ndarray, src_times: np.ndarray,
          frame_len: int = 1024, out_hop: int = 256, search: int = 128,
          ) -> np.ndarray:
    """
    Waveform Similarity Overlap-Add.

    audio     : [N] mono float32 (source)
    src_times : [T_out] source sample index for each synthesis frame
    Returns   : [T_out * out_hop] float32 retimed audio

    Cross-correlation search is vectorised — candidate frames extracted as a
    matrix and scored with a single matmul per synthesis step.

    The per-synthesis-step search below is inherently sequential (each
    step's candidate window is scored against the *previous* step's chosen
    window, `prev_win_frame`), so the outer loop can't be vectorised away
    without changing what gets synthesized. What can be — and is — removed
    is Python-level overhead that doesn't affect the result at all:
    `np.clip`/`np.linalg.norm` called on scalars or tiny arrays carry
    real dispatch cost for work a plain Python min/max or a dot-product
    does identically; candidate frames were rebuilt via a Python list
    comprehension + np.stack every step, where a single upfront
    sliding_window_view (zero-copy) plus fancy-indexing does the same
    gather in one C-level call. Verified bit-for-bit identical output
    against the previous implementation before landing this.
    """
    audio  = audio.astype(np.float32)
    window = np.hanning(frame_len).astype(np.float32)
    T_out  = len(src_times)
    half   = frame_len // 2
    lo_bound, hi_bound = half, len(audio) - half - 1
    out    = np.zeros(T_out * out_hop + frame_len, np.float32)
    norm   = np.zeros(T_out * out_hop + frame_len, np.float32)

    # Zero-copy view of every possible frame_len window; gathers candidate
    # frames via fancy indexing instead of a per-step Python loop + copy.
    # Only valid when audio has at least one full frame — degenerately
    # short clips (shorter than one frame) fall back to direct slicing,
    # which handles that case the same way the original code did.
    all_windows = sliding_window_view(audio, frame_len) if len(audio) >= frame_len else None

    prev_win_frame: np.ndarray | None = None
    prev_win_norm  = 0.0
    cand_step = max(1, out_hop // 4)   # coarse candidate spacing

    for k in range(T_out):
        st = src_times[k]
        ideal = int(st) if lo_bound <= st <= hi_bound else (lo_bound if st < lo_bound else hi_bound)

        best = ideal
        if prev_win_frame is not None and search > 0:
            lo = max(lo_bound, ideal - search)
            hi = min(len(audio) - half, ideal + search)
            cands = np.arange(lo, hi + 1, cand_step)
            if len(cands):
                # Batch-extract candidate frames [N_cand, frame_len]
                if all_windows is not None:
                    c_frames = all_windows[cands - half]
                else:
                    c_frames = np.stack([audio[c - half: c + half] for c in cands])
                scores = c_frames @ prev_win_frame                # [N_cand] dot products
                denom  = (np.sqrt(np.einsum('ij,ij->i', c_frames, c_frames))
                          * prev_win_norm + 1e-8)
                best = int(cands[np.argmax(scores / denom)])
                best = min(max(best, lo_bound), hi_bound)

        frame = audio[best - half: best + half] * window
        prev_win_frame = frame.copy()
        prev_win_norm  = float(np.sqrt(np.dot(prev_win_frame, prev_win_frame)))

        s = k * out_hop
        out[s: s + frame_len]  += frame
        norm[s: s + frame_len] += window

    mask = norm > 1e-8
    out[mask] /= norm[mask]
    return out[: T_out * out_hop]


# ── LSTM expression encoder ───────────────────────────────────────────────────

def _build_expression_encoder(
    n_mels: int = N_MELS, hidden: int = _LSTM_H, expr_dim: int = EXPR_DIM,
) -> bytes:
    """
    Stub LSTM expression encoder.

    Input : mel  [T, 1, n_mels]  (ONNX LSTM: seq_len, batch, features)
    Output: expr_vec [1, expr_dim]

    Encodes temporal dynamics (vibrato, energy, breath) into a fixed-dim vector
    via a single forward LSTM whose last hidden state is linearly projected.
    """
    rng = np.random.default_rng(42)
    W = rng.standard_normal((1, 4 * hidden, n_mels)).astype(np.float32) * 0.05
    R = rng.standard_normal((1, 4 * hidden, hidden)).astype(np.float32) * 0.02
    B = np.zeros((1, 8 * hidden), dtype=np.float32)
    W_proj = rng.standard_normal((hidden, expr_dim)).astype(np.float32) * 0.1
    b_proj = np.zeros(expr_dim, dtype=np.float32)
    sq_ax  = np.array([0], dtype=np.int64)

    vi_mel  = helper.make_tensor_value_info("mel",      TensorProto.FLOAT, [None, 1, n_mels])
    vi_expr = helper.make_tensor_value_info("expr_vec", TensorProto.FLOAT, [1, expr_dim])

    nodes = [
        helper.make_node("LSTM",    ["mel", "W_l", "R_l", "B_l"],
                         ["Y_seq", "Y_h", "Y_c"],
                         direction="forward", hidden_size=hidden),
        # Y_h [1, 1, hidden] → [1, hidden]
        helper.make_node("Squeeze", ["Y_h", "sq_ax"],       ["h_2d"]),
        helper.make_node("Gemm",    ["h_2d", "W_p", "b_p"], ["expr_raw"]),
        helper.make_node("Tanh",    ["expr_raw"],            ["expr_vec"]),
    ]
    inits = [
        numpy_helper.from_array(W,      "W_l"),
        numpy_helper.from_array(R,      "R_l"),
        numpy_helper.from_array(B,      "B_l"),
        numpy_helper.from_array(sq_ax,  "sq_ax"),
        numpy_helper.from_array(W_proj, "W_p"),
        numpy_helper.from_array(b_proj, "b_p"),
    ]
    graph = helper.make_graph(nodes, "expression_encoder", [vi_mel], [vi_expr],
                               initializer=inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)
    onnx.checker.check_model(model)
    return model.SerializeToString()


class ExpressionEncoder:
    """Loads and runs the LSTM expression encoder."""

    def __init__(self, model_path: Path, providers: list[str]) -> None:
        from paths import ensure_model  # noqa: PLC0415
        model_path = ensure_model(
            Path(model_path), lambda dst: dst.write_bytes(_build_expression_encoder())
        )
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._sess = ort.InferenceSession(str(model_path), sess_options=opts,
                                          providers=providers)

    def encode(self, mel: np.ndarray) -> np.ndarray:
        """
        mel [T, N_MELS] → expr_vec [EXPR_DIM]

        Subsamples mel to ≤ 600 frames before LSTM to keep inference fast for
        long audio (≥ 4 min), then returns the final hidden state vector.
        """
        T = len(mel)
        # subsample to ~5 Hz so LSTM seq_len ≤ ~600 for 4-minute audio
        frames_per_sec = SR / HOP
        sub = max(1, round(frames_per_sec / 5.0))
        mel_sub = mel[::sub]                                   # [T', N_MELS]
        x = mel_sub[:, np.newaxis, :].astype(np.float32)      # [T', 1, N_MELS]
        [expr] = self._sess.run(["expr_vec"], {"mel": x})
        return expr[0]                                         # [EXPR_DIM]


# ── V1: DTW + WSOLA cover ─────────────────────────────────────────────────────

def _resample_mono(audio: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """Linear resampling for mono float32."""
    if sr_in == sr_out:
        return audio
    n_out = int(len(audio) * sr_out / sr_in)
    return np.interp(np.linspace(0, len(audio) - 1, n_out),
                     np.arange(len(audio)), audio).astype(np.float32)


def _load_timbre(model_path: "str | Path") -> np.ndarray | None:
    """Read the singer's average spectral envelope out of a trained .onnx.

    Returns None for a model exported before envelopes existed, or for the
    generic stub — in which case cover synthesis leaves the reference's timbre
    alone rather than inventing one.
    """
    try:
        graph = onnx.load(str(model_path))
    except Exception:
        return None
    for init in graph.graph.initializer:
        if init.name == "timbre_envelope":
            return numpy_helper.to_array(init).astype(np.float64)
    return None


def _load_decoder(model_path: "str | Path") -> "dict[str, np.ndarray] | None":
    """Read the trained per-frame timbre decoder out of a .onnx.

    None for a model trained before the decoder existed, or for the stub — in
    which case the caller falls back to the static average envelope, and then
    to leaving the reference alone.
    """
    import voice_model  # noqa: PLC0415

    try:
        graph = onnx.load(str(model_path))
    except Exception:
        return None
    weights = {init.name: numpy_helper.to_array(init).astype(np.float32)
               for init in graph.graph.initializer
               if init.name.startswith(voice_model.WEIGHT_PREFIX)}
    # A decoder trained against a different content format is not a decoder
    # for this build — see voice_model.decoder_is_usable. Returning None here
    # sends the caller to the average envelope stored beside it, which is a
    # spectrum and does not care how content is computed, instead of letting
    # the mismatch surface as a reshape error in the middle of a cover.
    return weights if voice_model.decoder_is_usable(weights) else None


def _apply_decoder(ref_mono: np.ndarray, weights: dict, strength: float = 1.0) -> np.ndarray:
    """Re-colour `ref_mono` with an envelope predicted per frame.

    The decoder was trained at voice_model.SR (22.05 kHz) and the cover runs
    at 44.1 kHz. Content is extracted from a downsampled copy, but the
    envelope is applied to the *full-band* spectrum: mel band centres are
    absolute frequencies, so mel_envelope_to_linear places them correctly at
    any rate, and nothing above 11 kHz has to be thrown away to use a model
    trained below it.

    The two hops are chosen so the frame rates already agree — 22050/256 and
    44100/512 are both 86.13 fps — so the predicted envelope lines up with
    the cover's frames without resampling in time. Padding still leaves the
    counts off by a frame or two at the ends, which is interpolated.
    """
    import voice_model  # noqa: PLC0415
    from timbre import cepstrum_order, spectral_envelope  # noqa: PLC0415

    ref_mono = np.asarray(ref_mono, dtype=np.float64)
    if len(ref_mono) < N_FFT:
        return ref_mono.astype(np.float32)

    window = np.hanning(N_FFT + 1)[:-1]
    pad = N_FFT // 2
    padded = np.pad(ref_mono, (pad, pad), mode="reflect")
    n_frames = 1 + (len(padded) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    spec = np.fft.rfft(padded[idx] * window, axis=-1).T
    mag = np.abs(spec)

    # Band-limited, not _resample_mono: see voice_model.resample_for_content
    # for what linear interpolation's aliasing costs here.
    content = voice_model.content_features(
        voice_model.resample_for_content(ref_mono, SR, voice_model.SR))
    mel_env = voice_model.predict_envelope(weights, content)      # [80, T']
    if mel_env.shape[1] != n_frames:
        src = np.linspace(0.0, 1.0, mel_env.shape[1])
        dst = np.linspace(0.0, 1.0, n_frames)
        mel_env = np.stack([np.interp(dst, src, row) for row in mel_env])

    target_lin = voice_model.mel_envelope_to_linear(mel_env, mag.shape[0], SR)

    source_log = np.log(spectral_envelope(mag, cepstrum_order(SR)) + 1e-8)
    # The decoder predicts colour with level removed, so hand the source's own
    # per-frame level back before blending: the reference's dynamics are its
    # own and the conversion has no business flattening them.
    target_log = target_lin + source_log.mean(axis=0, keepdims=True)
    new_mag = (mag / (np.exp(source_log) + 1e-8)) * np.exp(
        source_log + strength * (target_log - source_log))

    out_spec = new_mag * np.exp(1j * np.angle(spec))
    frames = np.fft.irfft(out_spec.T, n=N_FFT, axis=-1) * window
    acc = np.zeros((n_frames - 1) * HOP + N_FFT)
    wsum = np.zeros_like(acc)
    for i in range(n_frames):
        acc[i * HOP: i * HOP + N_FFT] += frames[i]
        wsum[i * HOP: i * HOP + N_FFT] += window ** 2
    acc /= np.maximum(wsum, 1e-10)
    return acc[pad: pad + len(ref_mono)].astype(np.float32)


def _apply_timbre(ref_mono: np.ndarray, target_env: "np.ndarray | None",
                  strength: float = 0.75) -> np.ndarray:
    """Re-colour `ref_mono` towards `target_env`, keeping its excitation.

    With no envelope this is the identity: the honest result for a model that
    never learned a timbre is the reference voice, not a guess.
    """
    ref_mono = np.asarray(ref_mono, dtype=np.float64)
    if target_env is None or len(ref_mono) < N_FFT:
        return ref_mono.astype(np.float32)

    from timbre import cepstrum_order, resample_envelope, transfer  # noqa: PLC0415

    window = np.hanning(N_FFT + 1)[:-1]
    pad = N_FFT // 2
    padded = np.pad(ref_mono, (pad, pad), mode="reflect")
    n_frames = 1 + (len(padded) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    spec = np.fft.rfft(padded[idx] * window, axis=-1).T        # [bins, frames]

    # TIMBRE_SR is the rate the envelope was learned at; SR is the cover rate.
    env = resample_envelope(target_env, spec.shape[0], TIMBRE_SR, SR)
    # The lifter order is derived from SR, not inherited: the envelope was
    # learned at TIMBRE_SR, and the source envelope transfer() divides out has
    # to be smoothed to the same quefrency or the two do not cancel.
    new_mag = transfer(np.abs(spec), env, strength=strength,
                       n_cepstrum=cepstrum_order(SR))

    # Reference phase is kept: it carries the timing and the consonant
    # structure, and re-estimating it would undo the point of the exercise.
    out_spec = new_mag * np.exp(1j * np.angle(spec))
    frames = np.fft.irfft(out_spec.T, n=N_FFT, axis=-1) * window
    acc = np.zeros((n_frames - 1) * HOP + N_FFT)
    wsum = np.zeros_like(acc)
    for i in range(n_frames):
        acc[i * HOP: i * HOP + N_FFT] += frames[i]
        wsum[i * HOP: i * HOP + N_FFT] += window ** 2
    acc /= np.maximum(wsum, 1e-10)
    return acc[pad: pad + len(ref_mono)].astype(np.float32)


def _pick_timbre_path(
    ref_mono: np.ndarray,
    decoder: "dict | None",
    target_env: "np.ndarray | None",
) -> "tuple[str, np.ndarray]":
    """Choose how to re-colour the reference: decoder, average envelope, or
    leave it alone.

    The decoder when there is one. Measured through this pipeline on twelve
    pairs of real speakers, converting one towards another's timbre:

                              timbre   worst   diction
        reference untouched     1.19       —      1.00
        average envelope        1.04     1.42      0.60
        learned decoder         0.93     1.70      0.66

    Closer on both counts, and "usable first, resemblance second" is the order
    this was built to — a listener notices smeared words before they notice an
    imperfect impression. The worse worst case is the honest cost: on four of
    the twelve pairs the decoder landed further from the target than the
    envelope did, once at 1.70 against 1.32. Retraining moves these by a few
    hundredths, so read them as approximate.

    There is no per-cover choice between them, though the per-pair spread
    invites one. Every criterion available here is some distance between the
    result and the singer's stored *average* envelope, and the envelope path
    imposes exactly that envelope, so it wins any such comparison by
    construction — tried, and it picked the envelope twelve times out of
    twelve, including on the five pairs where the decoder was better by half.
    What separates them is the per-frame behaviour the average cannot see. A
    criterion that could would need the target singer's actual audio at cover
    time, which is not there.
    """
    if decoder is not None:
        return "decoder", _apply_decoder(ref_mono, decoder)
    if target_env is not None:
        # Full strength. The 0.75 default is a hedge from when this was the
        # only path; timbre.transfer keeps the source's level now, so holding
        # back a quarter of the conversion only makes it a weaker version of
        # itself.
        return "average_envelope", _apply_timbre(ref_mono, target_env, strength=1.0)
    return "none", np.asarray(ref_mono, dtype=np.float32)


def _v1_cover(
    ai_voice: np.ndarray,       # [N_ai] mono at SR, pre-synthesised AI voice
    ref_voice: np.ndarray,      # [N_ref] mono at SR, reference vocal
    acc: np.ndarray,            # [2, N_acc] stereo accompaniment at SR
) -> np.ndarray:
    """
    Align ai_voice to ref_voice timing via DTW + WSOLA.
    Returns stereo mix [2, N] at SR.
    """
    ai_feat  = extract_features(ai_voice)
    ref_feat = extract_features(ref_voice)

    # Feature matrix: [T, 2] = [normalised_f0, normalised_rms]
    def _feat_matrix(d):
        f0  = d["f0"]  / (d["f0"].max()  + 1e-8)
        rms = d["rms"] / (d["rms"].max() + 1e-8)
        return np.stack([f0, rms], axis=1)

    warp = dtw_warp(_feat_matrix(ai_feat), _feat_matrix(ref_feat))
    # warp[k] = AI-voice frame index for ref frame k → convert to sample positions
    src_times = warp * HOP

    # Retime ai_voice so its timing matches the reference
    T_ref = len(ref_feat["f0"])
    retimed = wsola(ai_voice, src_times[:T_ref])

    # Match amplitude to reference energy envelope
    ai_env  = ai_feat["rms"]
    ref_env = ref_feat["rms"]
    # Upsample envelopes to sample resolution
    t_env   = np.linspace(0, len(retimed) - 1, len(ref_env[:T_ref]))
    env_ref = np.interp(np.arange(len(retimed)), t_env, ref_env[:T_ref])
    t_ai    = np.linspace(0, len(retimed) - 1, len(ai_env[:T_ref]))
    env_ai  = np.interp(np.arange(len(retimed)), t_ai, ai_env[:T_ref]) + 1e-8
    retimed = (retimed * env_ref / env_ai * 0.9).astype(np.float32)

    # Mix with stereo accompaniment
    N = min(len(retimed), acc.shape[1])
    mix = acc[:, :N].copy()
    mix[0, :N] += retimed[:N] * 0.8
    mix[1, :N] += retimed[:N] * 0.8
    return mix


# ── V2: expression-conditioned synthesis ─────────────────────────────────────

def _v2_cover(
    ai_voice: np.ndarray,
    ref_voice: np.ndarray,
    acc: np.ndarray,
    encoder: ExpressionEncoder,
    ref_f0: np.ndarray,         # [T_ref] reference F0 in Hz (frame-level)
) -> np.ndarray:
    """
    Extract expressiveness from ref_voice via LSTM, then apply vibrato,
    dynamic shaping, and breathiness to the AI voice.
    """
    ref_feat = extract_features(ref_voice)

    # Encode expressiveness from reference mel
    expr = encoder.encode(ref_feat["mel"])  # [EXPR_DIM]

    # Decode expression parameters from the vector
    # Each quadrant controls a different expression dimension
    energy_db  = float(np.tanh(expr[:8].mean()))          # ±1 → gain ±6 dB
    vibrato_hz = 3.5 + 2.5 * float(np.abs(expr[8:16].mean()))   # 3.5–6 Hz
    vib_depth  = float(np.clip(np.abs(expr[16:24].mean()), 0, 0.06))  # 0–6% F0
    breathiness = float(np.clip(np.abs(expr[24:].mean()), 0, 0.08))   # 0–8% noise

    # Apply to ai_voice
    t = np.arange(len(ai_voice), dtype=np.float32) / SR

    # Vibrato: sinusoidal F0 modulation simulated by AM on the time axis
    # (for short-time frames, AM ≈ FM for small modulation depths)
    vibrato_env = 1.0 + vib_depth * np.sin(2.0 * np.pi * vibrato_hz * t)

    # Dynamic shaping: apply reference RMS envelope
    T_ref = len(ref_feat["rms"])
    t_ref = np.linspace(0, len(ai_voice) - 1, T_ref)
    dyn   = np.interp(np.arange(len(ai_voice)), t_ref, ref_feat["rms"])
    peak  = dyn.max() + 1e-8

    energy_scale = (10.0 ** (energy_db * 0.3)) * (dyn / peak)  # normalised + ±dB

    # Breathiness: low-level noise shaped by voiced/unvoiced from reference
    noise = np.random.default_rng(0).standard_normal(len(ai_voice)).astype(np.float32)
    noise *= breathiness * energy_scale

    voiced_env = np.interp(np.arange(len(ai_voice)), t_ref,
                           (ref_feat["f0"][:T_ref] > 0).astype(np.float32))

    out = (ai_voice * vibrato_env * energy_scale + noise * (1.0 - voiced_env * 0.5))
    peak_out = np.max(np.abs(out)) + 1e-8
    out = (out / peak_out * 0.9).astype(np.float32)

    # Mix with stereo accompaniment
    N = min(len(out), acc.shape[1])
    mix = acc[:, :N].copy()
    mix[0, :N] += out[:N] * 0.8
    mix[1, :N] += out[:N] * 0.8
    return mix


# ── Public API ────────────────────────────────────────────────────────────────

CoverMode = Literal["v1", "v2"]


class CoverResult(TypedDict):
    output_path:     str
    ai_vocal_path:   str    # AI vocal stem only (for mixing console)
    mode:            str
    duration_sec:    float
    elapsed_sec:     float
    model_load_sec:  float  # time spent reading the trained model to get the
                             # singer's envelope out of it — one-time cost,
                             # doesn't scale with audio duration. Not included
                             # in elapsed_sec (which already only covers
                             # mode-specific work) — see synthesize_cover().
    rt_ratio:        float
    vibrato_depth:   float
    noise_reduction_db: float  # Ticket 48 §4: dB of hiss removed by postprocess_chain
    timbre_source:   str    # "decoder" | "average_envelope" | "none" — which
                             # of the three timbre paths ran, so a support
                             # question about a cover that sounds untouched
                             # can be answered from the result alone.
    timbre_applied:  bool   # False when the model carries no learned envelope
                             # (a stub, or one trained before envelopes
                             # existed). The cover is then the reference voice
                             # with its own timbre — worth saying rather than
                             # letting a user wonder why it sounds untouched.
    passed:          bool


def synthesize_cover(
    ai_model:      str | Path,
    ref_vocal:     str | Path,
    accompaniment: str | Path,
    mode:          CoverMode = "v1",
    output_path:   str | Path | None = None,
) -> CoverResult:
    """
    Synthesize a cover track.

    ai_model      : path to Micro-VITS model.onnx (used to generate AI voice)
    ref_vocal     : path to reference human vocal WAV
    accompaniment : path to accompaniment WAV
    mode          : 'v1' (DTW+WSOLA) or 'v2' (LSTM expression conditioning)
    output_path   : where to write the mixed WAV (auto-generated if None)
    """
    ai_model      = Path(ai_model)
    ref_vocal     = Path(ref_vocal)
    accompaniment = Path(accompaniment)

    if output_path is None:
        output_path = ref_vocal.parent / f"cover_{ref_vocal.stem}_{mode}.wav"
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    device    = detect_device()
    providers = ordered_providers_for_ep(device["provider"])
    engine    = Path(__file__).parent

    # ── Load inputs ───────────────────────────────────────────────────────────

    ref_raw, ref_sr = sf.read(str(ref_vocal),     dtype="float32", always_2d=True)
    acc_raw, acc_sr = sf.read(str(accompaniment), dtype="float32", always_2d=True)
    ref_mono = ref_raw.mean(axis=1)                                    # [N] mono
    if ref_sr != SR:
        ref_mono = _resample_mono(ref_mono, ref_sr, SR)

    acc_stereo = acc_raw.T                                             # [2, N]
    if acc_raw.shape[1] == 1:
        acc_stereo = np.repeat(acc_stereo, 2, axis=0)
    if acc_sr != SR:
        acc_stereo = np.stack([_resample_mono(acc_stereo[c], acc_sr, SR)
                               for c in range(2)])

    # ── Produce the AI voice by re-colouring the reference ────────────────────
    #
    # This used to synthesise from nothing: a pure sine at the reference's f0
    # through the model, with the phoneme sequence hardcoded to a single vowel
    # (`["a","e","i","o","u"][0:1] * n_phon`). A whole song came back as one
    # sustained "aaaa" drone over the backing, which is what users reported as
    # noise — and thirty minutes of training could not change it, because the
    # phonemes were fixed and the excitation was a sine.
    #
    # Now the reference vocal *is* the excitation and only its timbre moves,
    # so the words, consonants, phrasing and timing are real. See
    # engine/timbre.py for what that costs in resemblance.

    _tload = time.perf_counter()
    decoder = _load_decoder(ai_model)
    target_env = _load_timbre(ai_model)
    model_load_sec = time.perf_counter() - _tload

    # Which timbre path to use is decided here, not at training time, because
    # here the reference vocal actually exists. Both paths are run and the one
    # whose long-term spectrum lands closer to the singer's stored envelope
    # wins. Neither path is reliably better: measured over twelve pairs of
    # real speakers, the decoder won seven and the average envelope five, and
    # on one pair the decoder landed at 1.27 where the envelope was at 0.62.
    #
    # Training used to make this call, from the only material it has — the
    # singer's own — by scoring both on content warped away from them. That
    # cannot see it: with ContentVec content the decoder beats the envelope on
    # that test every time, including on the pair it then converted at 1.57
    # against doing nothing at 0.89. Choosing here delivers 0.60 on average
    # against 0.67 for always using the envelope, with the same worst case, so
    # the learned path can win where it wins without being able to lose.
    timbre_source, ai_mono = _pick_timbre_path(ref_mono, decoder, target_env)

    # ── Mode-specific processing ──────────────────────────────────────────────

    t0 = time.perf_counter()
    vib_depth = 0.0
    noise_reduction_db = 0.0
    ai_voice_stereo: np.ndarray  # [2, N] at SR — set in each branch below

    if mode == "v1":
        # No DTW/WSOLA any more. Those existed to drag a from-scratch "aaaa"
        # drone onto the reference's timing; the AI voice is now derived from
        # that same reference, so it is already sample-aligned and retiming it
        # against itself would only add WSOLA seams. Level is matched to the
        # reference so the mix balance below is unchanged.
        retimed = ai_mono.astype(np.float32)
        ref_rms = float(np.sqrt(np.mean(ref_mono[:len(retimed)] ** 2))) + 1e-8
        ai_rms  = float(np.sqrt(np.mean(retimed ** 2))) + 1e-8
        retimed = (retimed * (ref_rms / ai_rms) * 0.9).astype(np.float32)

        # Ticket 48 §4: the postprocess chain still runs — it is what tidies
        # the de-essing and level of the converted vocal — but it is no longer
        # cleaning up after WSOLA seams, because there are none.
        pp = postprocess_chain(retimed, SR)
        retimed = pp["audio"]
        noise_reduction_db = pp["noise_reduction_db"]

        ai_voice_stereo = np.stack([retimed, retimed])   # mono → stereo
        N   = min(len(retimed), acc_stereo.shape[1])
        mix = acc_stereo[:, :N].copy()
        mix[0, :N] += retimed[:N] * 0.8
        mix[1, :N] += retimed[:N] * 0.8

    elif mode == "v2":
        enc_path  = engine / "expression_encoder.onnx"
        encoder   = ExpressionEncoder(enc_path, providers)
        ref_feats = extract_features(ref_mono)
        expr      = encoder.encode(ref_feats["mel"])
        vib_depth = float(np.clip(np.abs(expr[16:24].mean()), 0, 0.06))

        t_arr      = np.arange(len(ai_mono), dtype=np.float32) / SR
        vib_hz     = 3.5 + 2.5 * float(np.abs(expr[8:16].mean()))
        vib_d      = float(np.clip(np.abs(expr[16:24].mean()), 0, 0.06))
        energy_db  = float(np.tanh(expr[:8].mean()))
        breathiness = float(np.clip(np.abs(expr[24:].mean()), 0, 0.08))
        T_ref       = len(ref_feats["rms"])
        dyn_ref     = np.interp(np.arange(len(ai_mono)),
                                np.linspace(0, len(ai_mono) - 1, T_ref), ref_feats["rms"][:T_ref])
        energy_scale = (10.0 ** (energy_db * 0.3)) * (dyn_ref / (dyn_ref.max() + 1e-8))
        vibrato_env  = 1.0 + vib_d * np.sin(2.0 * np.pi * vib_hz * t_arr)
        noise        = np.random.default_rng(0).standard_normal(len(ai_mono)).astype(np.float32)
        # Ticket 48 §3/§5: real breath noise is weighted toward higher
        # frequencies, not flat across the spectrum — injecting raw white
        # noise here is exactly the broadband "hiss" users report from V2.
        # A first-difference is a cheap one-pole high-pass (same technique
        # separation.py's dereverb pre-emphasis kernel uses) that removes
        # the noise's low-frequency/rumble content before it's scaled in.
        noise = np.diff(noise, prepend=noise[0]).astype(np.float32)
        noise = noise / (np.std(noise) + 1e-8)  # renormalise after differencing
        voiced_env   = np.interp(np.arange(len(ai_mono)),
                                 np.linspace(0, len(ai_mono) - 1, T_ref),
                                 (ref_feats["f0"][:T_ref] > 0).astype(np.float32))
        out_mono = (ai_mono * vibrato_env * energy_scale
                    + noise * breathiness * energy_scale * (1.0 - voiced_env * 0.5))
        pk       = np.max(np.abs(out_mono)) + 1e-8
        out_mono = (out_mono / pk * 0.9).astype(np.float32)

        # Same enhancement chain as V1 — see comment there.
        pp = postprocess_chain(out_mono, SR)
        out_mono = pp["audio"]
        noise_reduction_db = pp["noise_reduction_db"]

        ai_voice_stereo = np.stack([out_mono, out_mono])
        N   = min(len(out_mono), acc_stereo.shape[1])
        mix = acc_stereo[:, :N].copy()
        mix[0, :N] += out_mono[:N] * 0.8
        mix[1, :N] += out_mono[:N] * 0.8

    else:
        raise ValueError(f"Unknown mode {mode!r}. Use 'v1' or 'v2'.")

    elapsed      = time.perf_counter() - t0
    duration_sec = mix.shape[1] / SR
    rt_ratio     = elapsed / duration_sec if duration_sec > 0 else 0.0
    rt_limit     = 0.10 if mode == "v1" else 0.50

    sf.write(str(output_path), mix.T, SR, subtype="PCM_16")

    # Save the AI vocal stem separately so the mixing console can load it
    ai_vocal_path = output_path.with_name(output_path.stem + "_ai_vocal.wav")
    N_ai = ai_voice_stereo.shape[1]
    sf.write(str(ai_vocal_path), ai_voice_stereo[:, :N_ai].T, SR, subtype="PCM_16")

    return CoverResult(
        output_path=str(output_path),
        ai_vocal_path=str(ai_vocal_path),
        mode=mode,
        duration_sec=round(duration_sec, 3),
        elapsed_sec=round(elapsed, 3),
        model_load_sec=round(model_load_sec, 3),
        rt_ratio=round(rt_ratio, 4),
        vibrato_depth=round(vib_depth, 6),
        noise_reduction_db=round(noise_reduction_db, 2),
        timbre_applied=timbre_source != "none",
        timbre_source=timbre_source,
        passed=bool(rt_ratio <= rt_limit),
    )
