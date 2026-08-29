"""
Audio source separation module.

Standard mode:  demucs_nano.onnx
                mix [1,2,N] → vocals [1,2,N] + accompaniment [1,2,N]

Enhanced mode:  sep_main.onnx → vocal_harmony_split.onnx → dereverb.onnx
                mix → lead_dry [1,2,N] + harmony_dry [1,2,N] + accompaniment [1,2,N]

All models process fixed-size overlapping chunks; a Hann-window overlap-add
(OLA) loop handles variable-length audio without memory overflow.
The Hann window satisfies the COLA property at 50% overlap, so
stem1 + stem2 == mix exactly (zero crosstalk for LTI models).
"""
from __future__ import annotations

import tempfile
import time
from pathlib import Path
from collections.abc import Callable
from typing import Literal, TypedDict

import numpy as np
import onnx
import onnxruntime as ort
import soundfile as sf
from onnx import TensorProto, helper, numpy_helper

from device_detector import detect_device, ordered_providers_for_ep

SAMPLE_RATE: int   = 44_100
CHUNK_SAMPLES: int = SAMPLE_RATE * 4   # 4-second analysis window
OVERLAP: float     = 0.50
HOP_SAMPLES: int   = int(CHUNK_SAMPLES * (1.0 - OVERLAP))  # 2-second hop

# ── stub model builders ───────────────────────────────────────────────────────

def _sinc_lp(cutoff_hz: float, n_taps: int) -> np.ndarray:
    """Hamming-windowed sinc lowpass FIR, unit DC gain."""
    n = np.arange(n_taps) - (n_taps - 1) / 2.0
    fc = cutoff_hz / SAMPLE_RATE
    with np.errstate(divide="ignore", invalid="ignore"):
        h = np.where(n == 0, 2.0 * fc, np.sin(2.0 * np.pi * fc * n) / (np.pi * n))
    h *= np.hamming(n_taps)
    return (h / h.sum()).astype(np.float32)


def _build_fir_separator(
    graph_name: str,
    cutoff_hz: float,
    lo_name: str,
    hi_name: str,
    n_taps: int = 127,
) -> bytes:
    """
    FIR two-stem separator.

    Inputs : mix [1, 2, N]
    Outputs: lo_name [1, 2, N]  (lowpass  → e.g. accompaniment)
             hi_name [1, 2, N]  (residual → e.g. vocals)

    Because hi = mix − lo, the two stems sum exactly to mix (zero crosstalk).
    """
    h   = _sinc_lp(cutoff_hz, n_taps)
    pad = (n_taps - 1) // 2                      # symmetric pad → same-length output
    # groups=2: apply the same filter independently to each stereo channel
    kernel = np.stack([h, h]).reshape(2, 1, n_taps)

    mix_vi = helper.make_tensor_value_info("mix",    TensorProto.FLOAT, [1, 2, None])
    lo_vi  = helper.make_tensor_value_info(lo_name,  TensorProto.FLOAT, [1, 2, None])
    hi_vi  = helper.make_tensor_value_info(hi_name,  TensorProto.FLOAT, [1, 2, None])

    nodes = [
        helper.make_node("Conv", ["mix", "lp_kernel"], [lo_name], group=2, pads=[pad, pad]),
        helper.make_node("Sub",  ["mix", lo_name],     [hi_name]),
    ]
    graph = helper.make_graph(
        nodes, graph_name, [mix_vi], [lo_vi, hi_vi],
        initializer=[numpy_helper.from_array(kernel, "lp_kernel")],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)
    onnx.checker.check_model(model)
    return model.SerializeToString()


def _build_vocal_harmony_split() -> bytes:
    """
    Mid-side stereo split for lead/harmony separation.

    Input : vocals  [1, 2, N]
    Output: lead    [1, 2, N]  – mid channel (center-panned, duplicated to stereo)
            harmony [1, 2, N]  – side channel (L-phase / R-antiphase)
    """
    s0     = np.array([0],    dtype=np.int64)
    e0     = np.array([1],    dtype=np.int64)
    s1     = np.array([1],    dtype=np.int64)
    e1     = np.array([2],    dtype=np.int64)
    ch_ax  = np.array([1],    dtype=np.int64)   # channel axis
    two    = np.array([2.0],  dtype=np.float32)

    vi_in      = helper.make_tensor_value_info("vocals",  TensorProto.FLOAT, [1, 2, None])
    vi_lead    = helper.make_tensor_value_info("lead",    TensorProto.FLOAT, [1, 2, None])
    vi_harmony = helper.make_tensor_value_info("harmony", TensorProto.FLOAT, [1, 2, None])

    nodes = [
        helper.make_node("Slice",  ["vocals", "s0", "e0", "ch_ax"], ["ch_L"]),
        helper.make_node("Slice",  ["vocals", "s1", "e1", "ch_ax"], ["ch_R"]),
        helper.make_node("Add",    ["ch_L",  "ch_R"],  ["mid_raw"]),
        helper.make_node("Div",    ["mid_raw", "two"], ["mid"]),
        helper.make_node("Sub",    ["ch_L",  "ch_R"],  ["side_raw"]),
        helper.make_node("Div",    ["side_raw", "two"], ["side"]),
        helper.make_node("Concat", ["mid",  "mid"],    ["lead"],    axis=1),
        helper.make_node("Neg",    ["side"],            ["neg_side"]),
        helper.make_node("Concat", ["side", "neg_side"], ["harmony"], axis=1),
    ]
    inits = [
        numpy_helper.from_array(s0,    "s0"),
        numpy_helper.from_array(e0,    "e0"),
        numpy_helper.from_array(s1,    "s1"),
        numpy_helper.from_array(e1,    "e1"),
        numpy_helper.from_array(ch_ax, "ch_ax"),
        numpy_helper.from_array(two,   "two"),
    ]
    graph = helper.make_graph(nodes, "vocal_harmony_split", [vi_in], [vi_lead, vi_harmony],
                               initializer=inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)
    onnx.checker.check_model(model)
    return model.SerializeToString()


def _build_dereverb() -> bytes:
    """
    Causal FIR pre-emphasis: dry[n] = wet[n] − 0.8·wet[n−1].
    Removes the low-frequency reverb tail without altering harmonic content.

    Input : wet [1, 2, N]
    Output: dry [1, 2, N]
    """
    alpha  = np.float32(0.8)
    kernel = np.array([-alpha, 1.0], dtype=np.float32).reshape(1, 1, 2)
    kernel = np.repeat(kernel, 2, axis=0)  # [2, 1, 2] – apply per channel

    vi_wet = helper.make_tensor_value_info("wet", TensorProto.FLOAT, [1, 2, None])
    vi_dry = helper.make_tensor_value_info("dry", TensorProto.FLOAT, [1, 2, None])

    nodes = [
        # pads=[1,0]: one sample of left-padding (causal) → same-length output
        helper.make_node("Conv", ["wet", "de_kernel"], ["dry"], group=2, pads=[1, 0]),
    ]
    graph = helper.make_graph(nodes, "dereverb", [vi_wet], [vi_dry],
                               initializer=[numpy_helper.from_array(kernel, "de_kernel")])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)
    onnx.checker.check_model(model)
    return model.SerializeToString()


# ── overlap-add processor ─────────────────────────────────────────────────────

class OLAProcessor:
    """
    Overlap-add (OLA) inference wrapper for variable-length stereo audio.

    Extracts overlapping chunks, runs the ONNX session on each, applies a
    Hann synthesis window, and accumulates.  Because the Hann window satisfies
    the COLA property at 50% overlap, the accumulated weight equals 1.0 for
    all interior samples — no normalisation error in the overlap region.
    """

    def __init__(self, session: ort.InferenceSession, input_name: str = "mix") -> None:
        self._sess        = session
        self._input_name  = input_name
        self._out_names   = [o.name for o in session.get_outputs()]
        self._window      = np.hanning(CHUNK_SAMPLES).astype(np.float32)  # COLA at 50% overlap

    def run(
        self,
        audio: np.ndarray,
        progress_cb: Callable[[float], None] | None = None,
    ) -> list[np.ndarray]:
        """
        audio : float32 [2, N]
        progress_cb : optional callback invoked after each chunk with this
            stage's completion as a 0.0-1.0 fraction. Used by separate() to
            report overall progress to the UI (FC-05) — the OLA loop is where
            essentially all of a separation's wall-clock time is spent, so it
            is the only place with anything meaningful to report.
        returns: list of float32 [2, N] stems (one per model output)
        """
        _, total = audio.shape
        n_hops     = max(1, -(-total // HOP_SAMPLES))   # ceiling division
        padded_len = n_hops * HOP_SAMPLES + HOP_SAMPLES  # pad so last chunk is full-size
        audio_pad  = np.pad(audio, ((0, 0), (0, padded_len - total)))

        accum  = [np.zeros((2, padded_len), np.float32) for _ in self._out_names]
        weight = np.zeros(padded_len, np.float32)

        starts    = list(range(0, padded_len - CHUNK_SAMPLES + 1, HOP_SAMPLES))
        n_chunks  = len(starts) or 1

        for done, start in enumerate(starts, start=1):
            end  = start + CHUNK_SAMPLES
            inp  = audio_pad[:, start:end][np.newaxis]  # [1, 2, CHUNK_SAMPLES]

            results = self._sess.run(self._out_names, {self._input_name: inp})

            for i, res in enumerate(results):
                # Window the output; COLA property ensures weight sums to 1 inside
                accum[i][:, start:end] += res[0] * self._window

            weight[start:end] += self._window

            if progress_cb is not None:
                progress_cb(done / n_chunks)

        denom = np.where(weight > 1e-8, weight, 1.0)
        return [acc[:, :total] / denom[:total] for acc in accum]


# ── public API ────────────────────────────────────────────────────────────────

SeparationMode = Literal["standard", "enhanced"]


class SeparationResult(TypedDict):
    mode:            str
    stems:           dict[str, str]   # stem_name → absolute file path
    elapsed_sec:     float
    model_load_sec:  float           # portion of elapsed_sec spent creating ONNX
                                      # sessions — a one-time cost that does NOT
                                      # scale with audio duration, unlike the rest
                                      # of elapsed_sec. See _test_suite.py's T04/T05.
    sample_rate:     int
    duration_sec:    float
    rt_ratio:        float            # elapsed / audio_duration


def separate(
    input_path: str | Path,
    mode: SeparationMode = "standard",
    output_dir: str | Path | None = None,
    progress_cb: Callable[[float, str], None] | None = None,
) -> SeparationResult:
    """
    Separate audio stems from input_path.

    Parameters
    ----------
    input_path:  Path to any libsndfile-readable audio file (WAV, FLAC, …)
    mode:        "standard"  → vocals + accompaniment
                 "enhanced"  → lead_dry + harmony_dry + accompaniment
    output_dir:  Directory for stem WAVs (default: <input_stem>_separated/)
    progress_cb: Optional callback invoked as (percent 0-100, stage name) while
                 the separation runs (FC-05). Stage weights below are fixed
                 fractions of the whole rather than measured ones: every stage
                 runs the same OLA loop over the same audio, so per-chunk cost
                 is near-identical between them and a static split tracks real
                 progress closely enough for a progress bar.

    Returns
    -------
    SeparationResult with paths to written stems and timing metadata
    """
    input_path = Path(input_path)
    if output_dir is None:
        output_dir = input_path.parent / f"{input_path.stem}_separated"
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    audio, sr = sf.read(str(input_path), dtype="float32", always_2d=True)
    audio = audio.T  # [channels, samples]
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)  # mono → fake stereo

    device    = detect_device()
    providers = ordered_providers_for_ep(device["provider"])
    engine    = Path(__file__).parent

    # Session creation (ONNX Runtime provider negotiation + CoreML/etc. graph
    # compilation) is a one-time cost, not something that scales with audio
    # duration — a 4-minute song pays it exactly once, same as a 5-second
    # clip. Tracked separately from elapsed_sec so callers that need to
    # estimate throughput on a different clip length (e.g. the benchmark
    # suite) can scale only the part that actually scales.
    model_load_sec = 0.0

    def _session(filename: str, stub_fn) -> ort.InferenceSession:
        nonlocal model_load_sec
        from paths import ensure_model  # noqa: PLC0415
        p = ensure_model(engine / filename, lambda dst: dst.write_bytes(stub_fn()))
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = 4
        ts0 = time.perf_counter()
        sess = ort.InferenceSession(str(p), sess_options=opts, providers=providers)
        model_load_sec += time.perf_counter() - ts0
        return sess

    t0: float = time.perf_counter()
    stems: dict[str, np.ndarray] = {}

    def _report(percent: float, stage: str) -> None:
        if progress_cb is not None:
            progress_cb(round(min(100.0, max(0.0, percent)), 1), stage)

    def _stage(offset: float, weight: float, stage: str) -> Callable[[float], None] | None:
        """Maps one OLA stage's 0-1 fraction onto its slice of the overall bar."""
        if progress_cb is None:
            return None
        return lambda frac: _report(offset + frac * weight, stage)

    _report(0.0, "loading")

    if mode == "standard":
        proc = OLAProcessor(
            _session(
                "demucs_nano.onnx",
                lambda: _build_fir_separator("demucs_nano", 4_000.0, "accompaniment", "vocals"),
            )
        )
        acc, voc = proc.run(audio, _stage(0.0, 95.0, "separating"))
        stems = {"accompaniment": acc, "vocals": voc}

    elif mode == "enhanced":
        # Stage 1 – coarse vocal/accompaniment split
        s1 = OLAProcessor(
            _session(
                "sep_main.onnx",
                lambda: _build_fir_separator("sep_main", 4_000.0, "accompaniment", "vocals"),
            )
        )
        acc, voc = s1.run(audio, _stage(0.0, 45.0, "separating"))

        # Stage 2 – mid-side lead / harmony split
        s2 = OLAProcessor(
            _session("vocal_harmony_split.onnx", _build_vocal_harmony_split),
            input_name="vocals",
        )
        lead, harmony = s2.run(voc, _stage(45.0, 25.0, "splitting_harmony"))

        # Stage 3 – dereverb each vocal stem
        s3_lead = OLAProcessor(
            _session("dereverb.onnx", _build_dereverb),
            input_name="wet",
        )
        s3_harm = OLAProcessor(
            _session("dereverb.onnx", _build_dereverb),
            input_name="wet",
        )
        lead_dry    = s3_lead.run(lead, _stage(70.0, 12.5, "dereverb"))[0]
        harmony_dry = s3_harm.run(harmony, _stage(82.5, 12.5, "dereverb"))[0]
        stems = {
            "lead_dry":      lead_dry,
            "harmony_dry":   harmony_dry,
            "accompaniment": acc,
        }

    else:
        raise ValueError(f"Unknown mode {mode!r}. Use 'standard' or 'enhanced'.")

    # Write stems to 16-bit WAV
    _report(95.0, "writing")
    stem_paths: dict[str, str] = {}
    for name, data in stems.items():
        out_file = output_dir / f"{input_path.stem}_{name}.wav"
        sf.write(str(out_file), data.T, SAMPLE_RATE, subtype="PCM_16")
        stem_paths[name] = str(out_file)

    _report(100.0, "done")

    elapsed      = time.perf_counter() - t0
    duration_sec = audio.shape[1] / SAMPLE_RATE

    return SeparationResult(
        mode=mode,
        stems=stem_paths,
        elapsed_sec=round(elapsed, 3),
        model_load_sec=round(model_load_sec, 3),
        sample_rate=SAMPLE_RATE,
        duration_sec=round(duration_sec, 3),
        rt_ratio=round(elapsed / duration_sec, 4) if duration_sec > 0 else 0.0,
    )
