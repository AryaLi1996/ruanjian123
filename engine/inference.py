"""Builds a tiny in-memory MatMul ONNX model and validates inference timing."""
from __future__ import annotations

import time
from typing import TypedDict

import numpy as np
import onnx
from onnx import TensorProto, helper

from device_detector import detect_device, ordered_providers_for_ep


class InferenceResult(TypedDict):
    passed: bool
    ep: str
    degraded: bool
    elapsed_ms: float
    output_shape: list[int]
    max_abs_error: float   # vs numpy reference


def _build_matmul_model(rows: int = 64, inner: int = 128, cols: int = 64) -> bytes:
    """Create a single-node MatMul ONNX model entirely in memory."""
    A = helper.make_tensor_value_info("A", TensorProto.FLOAT, [rows, inner])
    B = helper.make_tensor_value_info("B", TensorProto.FLOAT, [inner, cols])
    C = helper.make_tensor_value_info("C", TensorProto.FLOAT, [rows, cols])

    node = helper.make_node("MatMul", inputs=["A", "B"], outputs=["C"])
    graph = helper.make_graph([node], "matmul_test", [A, B], [C])
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 17)],
        ir_version=8,
    )
    onnx.checker.check_model(model)
    return model.SerializeToString()


def run_matmul_test() -> InferenceResult:
    """Load the tiny model, run inference, and return timing + correctness info."""
    import onnxruntime as ort  # noqa: PLC0415

    rows, inner, cols = 64, 128, 64
    rng = np.random.default_rng(42)
    A = rng.standard_normal((rows, inner)).astype(np.float32)
    B = rng.standard_normal((inner, cols)).astype(np.float32)
    expected = A @ B  # numpy reference

    device = detect_device()
    providers = ordered_providers_for_ep(device["provider"])

    model_bytes = _build_matmul_model(rows, inner, cols)

    sess_opts = ort.SessionOptions()
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    degraded = False
    try:
        sess = ort.InferenceSession(model_bytes, sess_opts, providers=providers)
    except Exception:
        # VM GPU drivers can expose an EP without being able to initialize it.
        device = {**device, "ep": "CPU", "provider": "CPUExecutionProvider"}
        degraded = True
        try:
            sess = ort.InferenceSession(
                model_bytes,
                sess_opts,
                providers=["CPUExecutionProvider"],
            )
        except Exception as error:
            raise RuntimeError(f"CPU warm-up inference unavailable: {error}") from error

    # warm-up pass (provider init cost excluded from timing)
    sess.run(["C"], {"A": A, "B": B})

    t0 = time.perf_counter()
    output = sess.run(["C"], {"A": A, "B": B})[0]
    elapsed_ms = (time.perf_counter() - t0) * 1000

    max_err = float(np.max(np.abs(output - expected)))

    return InferenceResult(
        passed=max_err < 1e-4,
        ep=device["ep"],
        degraded=degraded,
        elapsed_ms=round(elapsed_ms, 4),
        output_shape=list(output.shape),
        max_abs_error=round(max_err, 8),
    )
