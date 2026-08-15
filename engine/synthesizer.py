"""Micro-VITS singing voice synthesizer backed by ONNX Runtime.

Pipeline per call
-----------------
1. Python builds frame-level arrays from phoneme + F0 inputs:
   - audio_frames [T, HOP]: continuous-phase F0 sinusoids
   - phoneme_cond [T, HOP]: stationary formant conditioning per phoneme
2. Arrays are fed through the ONNX micro-vocoder in BATCH_FRAMES chunks.
3. Chunks are concatenated, peak-normalized, and returned as float32 PCM.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import TypedDict

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper

from device_detector import detect_device, ordered_providers_for_ep

SAMPLE_RATE: int = 22_050
HOP_SIZE: int = 256                         # audio samples per synthesis frame
FRAME_RATE: float = SAMPLE_RATE / HOP_SIZE  # ~86.1 frames / second
BATCH_FRAMES: int = 256                     # ~3 s per ORT call

# Simplified ARPA-like phoneme vocabulary
PHONEME_VOCAB: dict[str, int] = {
    "<pad>": 0, "<sil>": 1,
    "a": 2, "e": 3, "i": 4, "o": 5, "u": 6,
    "b": 7, "d": 8, "f": 9, "g": 10, "h": 11,
    "j": 12, "k": 13, "l": 14, "m": 15, "n": 16,
    "p": 17, "r": 18, "s": 19, "t": 20, "v": 21,
    "w": 22, "y": 23, "z": 24,
    "ng": 25, "th": 26, "sh": 27, "ch": 28,
}

# Average vocal-tract formant frequencies [F1, F2, F3] in Hz, and base amplitude.
# Consonants use lower amplitude; unrecognised phonemes fall back to voiced default.
_FORMANTS: dict[str, tuple[float, float, float, float]] = {
    "a":  (800.0, 1200.0, 2500.0, 1.00),
    "e":  (530.0, 1840.0, 2480.0, 0.92),
    "i":  (270.0, 2290.0, 3010.0, 0.88),
    "o":  (570.0,  840.0, 2410.0, 0.92),
    "u":  (300.0,  870.0, 2240.0, 0.85),
    "m":  (300.0, 1400.0, 2000.0, 0.55),
    "n":  (300.0, 1500.0, 2100.0, 0.55),
    "ng": (280.0, 1600.0, 2200.0, 0.50),
    "l":  (380.0, 1600.0, 2200.0, 0.65),
    "r":  (300.0, 1300.0, 1800.0, 0.60),
}
_FORMANT_DEFAULT = (500.0, 1500.0, 2500.0, 0.50)


def _formant_frame(ph: str, n_samples: int) -> np.ndarray:
    """Weighted sum of three formant sinusoids for one HOP-sized frame."""
    f1, f2, f3, amp = _FORMANTS.get(ph, _FORMANT_DEFAULT)
    t = np.arange(n_samples, dtype=np.float32) / SAMPLE_RATE
    sig = (
        0.50 * np.sin(2.0 * np.pi * f1 * t)
        + 0.30 * np.sin(2.0 * np.pi * f2 * t)
        + 0.20 * np.sin(2.0 * np.pi * f3 * t)
    )
    # Keep conditioning small relative to the F0 base signal
    return (sig * amp * 0.10).astype(np.float32)


# ── Stub ONNX model ───────────────────────────────────────────────────────────

def build_stub_model(hop: int = HOP_SIZE) -> bytes:
    """
    Create a micro-vocoder ONNX model in memory (< 1 MB).

    Graph:  audio_frames [B, T, hop]  ×  phoneme_cond [B, T, hop]
            ──────────────────────────────────────────────────────
            h0  = audio_frames @ W1                 MatMul
            h1  = h0 + b1                           Add
            h2  = h1 + phoneme_cond * ph_scale      Mul + Add
            h3  = h2 @ W2                           MatMul
            out = Flatten(h3 + b2, axis=1)          Add + Flatten → [B, T*hop]

    Weights are seeded near-identity so audio_frames pass through largely
    unchanged; phoneme_cond adds ~5% formant coloring.
    """
    rng = np.random.default_rng(0)
    noise = lambda: rng.standard_normal((hop, hop)).astype(np.float32) * 0.01
    W1 = np.eye(hop, dtype=np.float32) * 0.98 + noise()
    W2 = np.eye(hop, dtype=np.float32) * 0.98 + noise()
    b1 = np.zeros(hop, dtype=np.float32)
    b2 = np.zeros(hop, dtype=np.float32)
    ph_scale = np.full((1, 1, hop), 0.05, dtype=np.float32)

    af_vi  = helper.make_tensor_value_info("audio_frames", TensorProto.FLOAT, [None, None, hop])
    pc_vi  = helper.make_tensor_value_info("phoneme_cond",  TensorProto.FLOAT, [None, None, hop])
    out_vi = helper.make_tensor_value_info("audio",         TensorProto.FLOAT, [None, None])

    nodes = [
        helper.make_node("MatMul",  ["audio_frames", "W1"],       ["h0"]),
        helper.make_node("Add",     ["h0",  "b1"],                ["h1"]),
        helper.make_node("Mul",     ["phoneme_cond", "ph_scale"], ["pc_s"]),
        helper.make_node("Add",     ["h1",  "pc_s"],              ["h2"]),
        helper.make_node("MatMul",  ["h2",  "W2"],                ["h3"]),
        helper.make_node("Add",     ["h3",  "b2"],                ["frames_out"]),
        # Flatten [B, T, hop] → [B, T*hop]
        helper.make_node("Flatten", ["frames_out"],               ["audio"], axis=1),
    ]
    inits = [
        numpy_helper.from_array(W1,       "W1"),
        numpy_helper.from_array(b1,       "b1"),
        numpy_helper.from_array(W2,       "W2"),
        numpy_helper.from_array(b2,       "b2"),
        numpy_helper.from_array(ph_scale, "ph_scale"),
    ]
    graph = helper.make_graph(nodes, "micro_vits", [af_vi, pc_vi], [out_vi], initializer=inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)
    onnx.checker.check_model(model)
    return model.SerializeToString()


# ── Synthesizer ───────────────────────────────────────────────────────────────

class SynthesisResult(TypedDict):
    audio: list[float]    # float32 PCM at SAMPLE_RATE
    sample_rate: int
    duration_sec: float
    elapsed_ms: float
    ep: str
    n_frames: int


class Synthesizer:
    """
    Singing voice synthesizer.

    Wraps a Micro-VITS ONNX model.  The heavy lifting is split between:
    - Python: continuous-phase F0 sinusoid generation + formant conditioning
    - ONNX:   two-layer MLP vocoder shaping in BATCH_FRAMES-sized chunks
    """

    def __init__(self, model_path: str | Path) -> None:
        from paths import ensure_model  # noqa: PLC0415
        model_path = ensure_model(
            Path(model_path), lambda dst: dst.write_bytes(build_stub_model())
        )

        device = detect_device()
        providers = ordered_providers_for_ep(device["provider"])

        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = 4

        self._sess = ort.InferenceSession(
            str(model_path), sess_options=opts, providers=providers
        )
        self._ep = device["ep"]

        # amortise EP initialisation before real synthesis
        dummy = np.zeros((1, 1, HOP_SIZE), dtype=np.float32)
        self._sess.run(["audio"], {"audio_frames": dummy, "phoneme_cond": dummy})

    # ------------------------------------------------------------------
    def synthesize(
        self,
        phonemes: list[str],
        f0_hz: list[float],
        durations_sec: list[float] | None = None,
    ) -> SynthesisResult:
        """
        Synthesize singing voice PCM.

        Parameters
        ----------
        phonemes:       Phoneme sequence, e.g. ["d", "o", "r", "e", "m", "i"]
        f0_hz:          F0 per phoneme in Hz, same length as phonemes
        durations_sec:  Duration per phoneme in seconds (default 0.5 s each)

        Returns
        -------
        SynthesisResult with float32 audio at SAMPLE_RATE Hz
        """
        if durations_sec is None:
            durations_sec = [0.5] * len(phonemes)
        if not len(phonemes) == len(f0_hz) == len(durations_sec):
            raise ValueError("phonemes, f0_hz, and durations_sec must be the same length")

        af_rows: list[np.ndarray] = []
        pc_rows: list[np.ndarray] = []
        phase = 0.0  # continuous phase to prevent inter-phoneme clicks

        for ph, f0, dur in zip(phonemes, f0_hz, durations_sec):
            n_ph_frames = max(1, round(dur * FRAME_RATE))
            ph_cond = _formant_frame(ph, HOP_SIZE)  # same cond for every frame of this phoneme
            dp = 2.0 * np.pi * max(f0, 0.0) / SAMPLE_RATE
            k = np.arange(HOP_SIZE, dtype=np.float64)

            for _ in range(n_ph_frames):
                af_rows.append(np.sin(phase + dp * k).astype(np.float32))
                pc_rows.append(ph_cond)
                phase = (phase + dp * HOP_SIZE) % (2.0 * np.pi)

        total_frames = len(af_rows)
        af_arr = np.stack(af_rows)  # [T, HOP]
        pc_arr = np.stack(pc_rows)  # [T, HOP]

        t0 = time.perf_counter()
        chunks: list[np.ndarray] = []

        for start in range(0, total_frames, BATCH_FRAMES):
            end = min(start + BATCH_FRAMES, total_frames)
            out = self._sess.run(
                ["audio"],
                {
                    "audio_frames": af_arr[start:end][np.newaxis],  # [1, chunk, HOP]
                    "phoneme_cond": pc_arr[start:end][np.newaxis],
                },
            )
            chunks.append(out[0][0])  # [chunk * HOP]

        audio = np.concatenate(chunks).astype(np.float32)
        peak = np.max(np.abs(audio))
        if peak > 1e-8:
            audio = audio / peak * 0.95  # normalize to ±0.95 FS

        elapsed_ms = (time.perf_counter() - t0) * 1000
        duration_sec = len(audio) / SAMPLE_RATE

        return SynthesisResult(
            audio=audio.tolist(),
            sample_rate=SAMPLE_RATE,
            duration_sec=round(duration_sec, 3),
            elapsed_ms=round(elapsed_ms, 3),
            ep=self._ep,
            n_frames=total_frames,
        )
