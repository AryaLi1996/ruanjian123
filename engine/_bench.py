#!/usr/bin/env python3
"""
Ruanjian performance benchmark — measures throughput and variance for
each engine operation across multiple runs.

Outputs a JSON report suitable for CI artifact upload and trend tracking.

Usage:
  python _bench.py                       # all benchmarks, 3 iterations each
  python _bench.py --iters 10            # more iterations for stable stats
  python _bench.py --only synthesis,sep  # selective
  python _bench.py --output bench.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

# ── Helpers ───────────────────────────────────────────────────────────────────

def _sine(freq: float, dur: float, sr: int = 22050) -> np.ndarray:
    t = np.arange(int(sr * dur), dtype=np.float32) / sr
    return np.sin(2.0 * np.pi * freq * t).astype(np.float32)


def _stereo(dur: float, sr: int = 44100) -> np.ndarray:
    t = np.arange(int(sr * dur), dtype=np.float32) / sr
    return np.stack([0.4 * np.sin(2 * np.pi * 440 * t),
                     0.4 * np.sin(2 * np.pi * 880 * t)]).astype(np.float32)


def _write_wav(path: Path, audio: np.ndarray, sr: int) -> None:
    import soundfile as sf  # noqa: PLC0415
    sf.write(str(path), audio.T if audio.ndim == 2 else audio, sr, subtype="PCM_16")


def _stats(times: list[float]) -> dict[str, float]:
    a = np.array(times)
    return {
        "mean":   float(a.mean()),
        "std":    float(a.std()),
        "min":    float(a.min()),
        "max":    float(a.max()),
        "p50":    float(np.percentile(a, 50)),
        "p95":    float(np.percentile(a, 95)),
    }


def _time_fn(fn, *args, n: int = 3, **kwargs) -> tuple[Any, dict]:
    """Run fn n times and return (last_result, stats_dict)."""
    times, result = [], None
    for _ in range(n):
        t0 = time.perf_counter()
        result = fn(*args, **kwargs)
        times.append(time.perf_counter() - t0)
    return result, _stats(times)


# ── Benchmarks ────────────────────────────────────────────────────────────────

def bench_inference(n: int) -> dict:
    from inference import run_matmul_test  # noqa: PLC0415
    _, stats = _time_fn(run_matmul_test, n=n)
    return {"name": "MatMul inference", "unit": "s", **stats}


def bench_synthesis(duration: float, n: int) -> dict:
    from synthesizer import Synthesizer  # noqa: PLC0415
    model = Path(__file__).parent / "model.onnx"
    synth = Synthesizer(model)
    phon  = ["a", "e"] * 50; f0 = [440.0, 494.0] * 50; dur = [duration / 100] * 100
    _, stats = _time_fn(synth.synthesize, phon[:20], f0[:20], dur[:20], n=n)
    return {"name": f"Synthesis ({duration}s)", "unit": "s",
            "audio_duration": duration, **stats,
            "rt_ratio_mean": round(stats["mean"] / duration, 4)}


def bench_separation_standard(duration: float, n: int) -> dict:
    from separation import separate  # noqa: PLC0415
    tmp = Path(__file__).parent / "_test_data"; tmp.mkdir(exist_ok=True)
    inp = tmp / "bench_std_sep.wav"
    _write_wav(inp, _stereo(duration), 44100)
    _, stats = _time_fn(separate, str(inp), mode="standard",
                        output_dir=str(tmp / "bench_std_out"), n=n)
    return {"name": f"Standard separation ({duration}s)", "unit": "s",
            "audio_duration": duration, **stats,
            "equiv_4m_sec_mean": round(stats["mean"] * 240.0 / duration, 2)}


def bench_separation_enhanced(duration: float, n: int) -> dict:
    from separation import separate  # noqa: PLC0415
    tmp = Path(__file__).parent / "_test_data"; tmp.mkdir(exist_ok=True)
    inp = tmp / "bench_enh_sep.wav"
    _write_wav(inp, _stereo(duration), 44100)
    _, stats = _time_fn(separate, str(inp), mode="enhanced",
                        output_dir=str(tmp / "bench_enh_out"), n=n)
    return {"name": f"Enhanced separation ({duration}s)", "unit": "s",
            "audio_duration": duration, **stats,
            "equiv_4m_sec_mean": round(stats["mean"] * 240.0 / duration, 2)}


def bench_cover_v1(duration: float, n: int) -> dict:
    from cover_synthesis import synthesize_cover  # noqa: PLC0415
    tmp = Path(__file__).parent / "_test_data"; tmp.mkdir(exist_ok=True)
    ref = tmp / "bench_cover_ref.wav"; acc = tmp / "bench_cover_acc.wav"
    _write_wav(ref, _stereo(duration), 44100)
    _write_wav(acc, _stereo(duration) * 0.5, 44100)
    model = Path(__file__).parent / "model.onnx"
    _, stats = _time_fn(synthesize_cover, str(model), str(ref), str(acc),
                        mode="v1", n=n)
    return {"name": f"Cover V1 ({duration}s)", "unit": "s",
            "audio_duration": duration, **stats,
            "rt_ratio_mean": round(stats["mean"] / duration, 4)}


def bench_cover_v2(duration: float, n: int) -> dict:
    from cover_synthesis import synthesize_cover  # noqa: PLC0415
    tmp = Path(__file__).parent / "_test_data"; tmp.mkdir(exist_ok=True)
    ref = tmp / "bench_coverv2_ref.wav"; acc = tmp / "bench_coverv2_acc.wav"
    _write_wav(ref, _stereo(duration), 44100)
    _write_wav(acc, _stereo(duration) * 0.5, 44100)
    model = Path(__file__).parent / "model.onnx"
    _, stats = _time_fn(synthesize_cover, str(model), str(ref), str(acc),
                        mode="v2", n=n)
    return {"name": f"Cover V2 ({duration}s)", "unit": "s",
            "audio_duration": duration, **stats,
            "rt_ratio_mean": round(stats["mean"] / duration, 4)}


def bench_watermark(n: int) -> dict:
    from watermark import Watermarker  # noqa: PLC0415
    wm    = Watermarker(Path(__file__).parent / "watermark_embed.onnx")
    audio = _sine(440.0, 2.0)
    _, stats = _time_fn(wm.embed, audio, "bench_user", 0, n=n)
    return {"name": "Watermark embed (2s)", "unit": "s", **stats,
            "ms_mean": round(stats["mean"] * 1000, 2)}


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="Ruanjian performance benchmark")
    ap.add_argument("--iters",  type=int, default=3, help="Iterations per benchmark")
    ap.add_argument("--dur",    type=float, default=30.0, help="Audio duration for speed tests (s)")
    ap.add_argument("--only",   default="", help="Comma-separated subset: inference,synthesis,sep,cover,watermark")
    ap.add_argument("--output", metavar="FILE", help="Write JSON report to FILE")
    args  = ap.parse_args()

    only  = set(args.only.split(",")) if args.only else None
    n     = args.iters
    dur   = args.dur
    results: list[dict] = []

    def _run(key: str, fn, *a, **kw):
        if only and key not in only:
            return
        print(f"  Running {key}…", end=" ", flush=True)
        t0 = time.perf_counter()
        try:
            r = fn(*a, **kw)
            elapsed = time.perf_counter() - t0
            print(f"mean={r['mean']:.3f}s  p95={r['p95']:.3f}s  ({elapsed:.1f}s total)")
            results.append(r)
        except Exception as e:
            print(f"ERROR: {e}")

    print(f"\nRuanjian Benchmark  (iters={n}, dur={dur}s)\n{'─'*50}")
    _run("inference",  bench_inference,            n)
    _run("synthesis",  bench_synthesis,   dur,     n)
    _run("sep",        bench_separation_standard, dur, n)
    _run("sep",        bench_separation_enhanced, dur, n)
    _run("cover",      bench_cover_v1,   dur,     n)
    _run("cover",      bench_cover_v2,   dur,     n)
    _run("watermark",  bench_watermark,            n)

    print(f"{'─'*50}\n{len(results)} benchmarks complete\n")

    report = {"iterations": n, "audio_duration": dur, "results": results}
    if args.output:
        Path(args.output).write_text(json.dumps(report, indent=2))
        print(f"Benchmark report written to {args.output}")


if __name__ == "__main__":
    main()
