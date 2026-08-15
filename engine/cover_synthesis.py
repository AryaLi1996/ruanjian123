"""
Dual-version cover synthesis.

V1 (efficiency):   F0/energy extraction  →  DTW alignment  →  WSOLA retiming
V2 (precision):    mel extraction  →  LSTM expression encoder  →  expression-
                   conditioned synthesis (vibrato, breath, dynamics injection)

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
from onnx import TensorProto, helper, numpy_helper

from device_detector import detect_device, ordered_providers_for_ep
from synthesizer import Synthesizer, SAMPLE_RATE as SYNTH_SR, HOP_SIZE as SYNTH_HOP

# ── Module constants ──────────────────────────────────────────────────────────

SR      = 44_100          # cover-synthesis sample rate
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
        # Vectorised inner axis avoids a second Python loop
        D[i, 1:] = C[i, 1:] + np.minimum(
            np.minimum(D[i - 1, :-1], D[i - 1, 1:]),
            D[i, :-1],
        )

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
    """
    audio  = audio.astype(np.float32)
    window = np.hanning(frame_len).astype(np.float32)
    T_out  = len(src_times)
    half   = frame_len // 2
    out    = np.zeros(T_out * out_hop + frame_len, np.float32)
    norm   = np.zeros(T_out * out_hop + frame_len, np.float32)

    prev_win_frame: np.ndarray | None = None
    cand_step = max(1, out_hop // 4)   # coarse candidate spacing

    for k in range(T_out):
        ideal = int(np.clip(src_times[k], half, len(audio) - half - 1))

        best = ideal
        if prev_win_frame is not None and search > 0:
            lo = max(half, ideal - search)
            hi = min(len(audio) - half, ideal + search)
            cands = np.arange(lo, hi + 1, cand_step)
            if len(cands):
                # Batch-extract candidate frames [N_cand, frame_len]
                c_frames = np.stack([audio[c - half: c + half] for c in cands])
                scores   = c_frames @ prev_win_frame              # [N_cand] dot products
                denom    = (np.linalg.norm(c_frames, axis=1)
                            * np.linalg.norm(prev_win_frame) + 1e-8)
                best = int(cands[np.argmax(scores / denom)])
                best = int(np.clip(best, half, len(audio) - half - 1))

        frame = audio[best - half: best + half] * window
        prev_win_frame = frame.copy()

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
    output_path:    str
    ai_vocal_path:  str    # AI vocal stem only (for mixing console)
    mode:           str
    duration_sec:   float
    elapsed_sec:    float
    rt_ratio:       float
    vibrato_depth:  float
    passed:         bool


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

    # ── Generate AI voice from reference F0 contour ───────────────────────────

    ref_f0_feat = extract_features(ref_mono)["f0"]                    # [T] Hz

    # Build a simple phoneme sequence from the voiced F0 frames
    frames_per_phoneme = max(1, round(SR / HOP * 0.25))               # 0.25 s per phoneme
    voiced_f0 = ref_f0_feat[ref_f0_feat > 0]
    if len(voiced_f0) == 0:
        voiced_f0 = np.array([440.0])

    # Aggregate into phoneme-length segments
    n_phon = max(1, len(ref_f0_feat) // frames_per_phoneme)
    seg_f0 = [float(ref_f0_feat[i * frames_per_phoneme:
                                (i + 1) * frames_per_phoneme].mean())
              for i in range(n_phon)]
    seg_f0 = [f if f > 0 else float(voiced_f0.mean()) for f in seg_f0]
    phonemes  = ["a", "e", "i", "o", "u"][0:1] * n_phon              # simple vowel sequence
    durations = [0.25] * n_phon

    synth = Synthesizer(ai_model)
    synth_result = synth.synthesize(phonemes, seg_f0, durations)
    ai_audio_raw = np.array(synth_result["audio"], dtype=np.float32)  # at SYNTH_SR, mono

    # Resample to cover SR
    ai_mono = _resample_mono(ai_audio_raw, SYNTH_SR, SR)

    # ── Mode-specific processing ──────────────────────────────────────────────

    t0 = time.perf_counter()
    vib_depth = 0.0
    ai_voice_stereo: np.ndarray  # [2, N] at SR — set in each branch below

    if mode == "v1":
        ai_feat  = extract_features(ai_mono)
        ref_feat = extract_features(ref_mono)

        def _feat_matrix(d):
            f0  = d["f0"]  / (d["f0"].max()  + 1e-8)
            rms = d["rms"] / (d["rms"].max() + 1e-8)
            return np.stack([f0, rms], axis=1)

        warp    = dtw_warp(_feat_matrix(ai_feat), _feat_matrix(ref_feat))
        T_ref   = len(ref_feat["f0"])
        retimed = wsola(ai_mono, warp * HOP)

        env_ref = np.interp(np.arange(len(retimed)),
                            np.linspace(0, len(retimed) - 1, T_ref), ref_feat["rms"][:T_ref])
        env_ai  = np.interp(np.arange(len(retimed)),
                            np.linspace(0, len(retimed) - 1, len(ai_feat["rms"])),
                            ai_feat["rms"]) + 1e-8
        retimed = (retimed * env_ref / env_ai * 0.9).astype(np.float32)

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
        voiced_env   = np.interp(np.arange(len(ai_mono)),
                                 np.linspace(0, len(ai_mono) - 1, T_ref),
                                 (ref_feats["f0"][:T_ref] > 0).astype(np.float32))
        out_mono = (ai_mono * vibrato_env * energy_scale
                    + noise * breathiness * energy_scale * (1.0 - voiced_env * 0.5))
        pk       = np.max(np.abs(out_mono)) + 1e-8
        out_mono = (out_mono / pk * 0.9).astype(np.float32)

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
        rt_ratio=round(rt_ratio, 4),
        vibrato_depth=round(vib_depth, 6),
        passed=bool(rt_ratio <= rt_limit),
    )
