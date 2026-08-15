"""
Audio blind watermark — spread-spectrum frequency-domain embedding.

Embedding  : UID + timestamp → 256-bit hash → spread over audio via a fixed
             random projection matrix (seed 0x57415445).  Amplitude ≈ 0.001
             (−60 dBFS, completely inaudible).

Verification: recompute the spread pattern for the claimed UID+timestamp and
             measure the normalised cross-correlation against the audio.
             Correlation > THRESHOLD confirms the watermark is intact.

The process is *blind*: extraction requires only the UID + timestamp, NOT
the original unwatermarked signal.
"""
from __future__ import annotations

import hashlib
import time
from pathlib import Path
from typing import TypedDict

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper

FRAME_LEN  = 1024      # samples processed per ORT call
UID_DIM    = 32        # dimension of the uid projection vector
EPSILON    = 0.001     # watermark amplitude (−60 dBFS)
THRESHOLD  = 0.12      # cross-correlation detection threshold
_SEED      = 0x57415445  # "WATE"


# ── Fixed random projection matrix (must match embed & verify) ────────────────

def _get_spread_matrix() -> np.ndarray:
    """[UID_DIM, FRAME_LEN] float32 — fixed across all runs via deterministic seed."""
    rng = np.random.default_rng(_SEED)
    W   = rng.standard_normal((UID_DIM, FRAME_LEN)).astype(np.float32)
    # L2-normalise each column so spread has unit energy per frame position
    W  /= (np.linalg.norm(W, axis=0, keepdims=True) + 1e-8)
    return W


_SPREAD_MATRIX: np.ndarray = _get_spread_matrix()


def _uid_to_vec(uid: str, timestamp: int | None = None) -> np.ndarray:
    """Hash UID + timestamp → normalised float32 [1, UID_DIM]."""
    raw   = f"{uid}:{timestamp or 0}".encode()
    digest = hashlib.sha256(raw).digest()  # 32 bytes → exactly UID_DIM floats
    vec   = np.frombuffer(digest, dtype=np.uint8).astype(np.float32)
    vec   = (vec / 127.5) - 1.0           # map [0,255] → [-1, 1]
    return vec.reshape(1, UID_DIM)


# ── ONNX stub model builder ───────────────────────────────────────────────────

def build_watermark_model(output_path: Path) -> int:
    """
    Build watermark_embed.onnx.

    Inputs : audio   [1, FRAME_LEN]  float32
             uid_vec [1, UID_DIM]    float32
    Output : audio_w [1, FRAME_LEN]  float32

    audio_w = audio + EPSILON * (uid_vec @ W)
    """
    eps_val = np.array([EPSILON], dtype=np.float32)
    W       = _SPREAD_MATRIX   # [UID_DIM, FRAME_LEN]

    vi_audio  = helper.make_tensor_value_info("audio",   TensorProto.FLOAT, [1, FRAME_LEN])
    vi_uid    = helper.make_tensor_value_info("uid_vec", TensorProto.FLOAT, [1, UID_DIM])
    vi_out    = helper.make_tensor_value_info("audio_w", TensorProto.FLOAT, [1, FRAME_LEN])

    nodes = [
        helper.make_node("MatMul", ["uid_vec", "W"],        ["pattern"]),
        helper.make_node("Mul",    ["pattern",  "epsilon"], ["scaled"]),
        helper.make_node("Add",    ["audio",    "scaled"],  ["audio_w"]),
    ]
    inits = [
        numpy_helper.from_array(W,       "W"),
        numpy_helper.from_array(eps_val, "epsilon"),
    ]
    graph = helper.make_graph(nodes, "watermark_embed", [vi_audio, vi_uid], [vi_out],
                               initializer=inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)
    onnx.checker.check_model(model)
    raw = model.SerializeToString()
    output_path.write_bytes(raw)
    return len(raw)


# ── Watermarker class ─────────────────────────────────────────────────────────

class WatermarkResult(TypedDict):
    detected:    bool
    correlation: float
    uid:         str | None
    timestamp:   int | None
    confidence:  str  # "high" | "medium" | "low" | "none"


class Watermarker:
    def __init__(self, model_path: Path) -> None:
        from paths import ensure_model  # noqa: PLC0415
        model_path = ensure_model(Path(model_path), build_watermark_model)

        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._sess = ort.InferenceSession(str(model_path),
                                          sess_options=opts,
                                          providers=["CPUExecutionProvider"])

    def embed(self, audio: np.ndarray, uid: str, timestamp: int | None = None) -> np.ndarray:
        """
        Embed watermark into mono float32 audio.
        audio : [N] float32
        Returns watermarked [N] float32 (imperceptible modification ≈ −60 dBFS).
        """
        uid_vec = _uid_to_vec(uid, timestamp)  # [1, UID_DIM]
        out     = np.empty_like(audio)
        n_full  = len(audio) // FRAME_LEN

        for i in range(n_full):
            s, e = i * FRAME_LEN, (i + 1) * FRAME_LEN
            frame = audio[s:e].reshape(1, FRAME_LEN)
            [wm]  = self._sess.run(["audio_w"], {"audio": frame, "uid_vec": uid_vec})
            out[s:e] = wm[0]

        # Copy any trailing samples unchanged
        tail = n_full * FRAME_LEN
        if tail < len(audio):
            out[tail:] = audio[tail:]

        return out.astype(np.float32)

    def verify(self, audio: np.ndarray, uid: str, timestamp: int | None = None) -> WatermarkResult:
        """
        Verify whether `audio` contains a watermark matching uid + timestamp.
        Does NOT require the original unwatermarked signal (blind extraction).
        """
        uid_vec = _uid_to_vec(uid, timestamp)
        # Recompute the expected spread pattern for this uid
        pattern = (uid_vec @ _SPREAD_MATRIX)[0]   # [FRAME_LEN]
        pattern /= np.linalg.norm(pattern) + 1e-8

        n_full = len(audio) // FRAME_LEN
        if n_full == 0:
            return WatermarkResult(detected=False, correlation=0.0, uid=None,
                                   timestamp=None, confidence="none")

        correlations = np.empty(n_full, dtype=np.float64)
        for i in range(n_full):
            frame = audio[i * FRAME_LEN: (i + 1) * FRAME_LEN].astype(np.float64)
            norm  = np.linalg.norm(frame) + 1e-8
            correlations[i] = np.dot(frame / norm, pattern)

        corr = float(np.mean(correlations))
        det  = corr > THRESHOLD

        if   corr > THRESHOLD * 2.0: confidence = "high"
        elif corr > THRESHOLD:        confidence = "medium"
        elif corr > THRESHOLD * 0.5:  confidence = "low"
        else:                          confidence = "none"

        return WatermarkResult(
            detected=det,
            correlation=round(corr, 6),
            uid=uid if det else None,
            timestamp=timestamp if det else None,
            confidence=confidence,
        )
