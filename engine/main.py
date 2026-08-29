#!/usr/bin/env python3
"""AI engine entry point.

Reads a JSON payload from the last argv entry: {"method": "...", "args": [...]}
Prints a JSON result to stdout and exits 0, or exits 1 on error.

Flags may precede the payload:

    --verbose   emit stage diagnostics (and a liveness heartbeat) on stderr

Ticket T1: stdout is the JSON protocol channel and must stay clean, so every
diagnostic goes to stderr, tagged with LOG_PREFIX / HEARTBEAT_PREFIX. The
Electron bridge (src/main/python-bridge.ts) forwards those lines to the
training log panel and uses them to tell "still starting up" from "hung",
which is what the old, silent 15s startup timeout could not do: a cold
`import torch` off a slow disk regularly takes longer than that while being
perfectly healthy.
"""
from __future__ import annotations

import sys
import json
import os
import threading
import time
from pathlib import Path

# Tags let the bridge classify stderr lines: diagnostics to show the user,
# heartbeats that prove liveness, and everything else (a real traceback).
LOG_PREFIX       = "[engine]"
HEARTBEAT_PREFIX = "[engine:heartbeat]"

# Verbose is opt-in via --verbose or RUANJIAN_ENGINE_VERBOSE=1, so direct
# CLI/test callers keep the quiet, machine-readable behaviour they had.
_verbose = os.environ.get("RUANJIAN_ENGINE_VERBOSE") == "1"
_stage   = "starting"


def _log(message: str) -> None:
    """Stage diagnostic on stderr. No-op unless verbose."""
    if not _verbose:
        return
    try:
        print(f"{LOG_PREFIX} {message}", file=sys.stderr, flush=True)
    except Exception:
        pass  # a broken stderr pipe must never take down the engine


def _start_heartbeat(interval_sec: float = 5.0) -> None:
    """Print a liveness line every few seconds while a handler runs.

    Long, silent stretches are normal here (importing torch, loading an ONNX
    session, the first epoch of a CPU training run). Without this the bridge
    cannot distinguish them from a process that antivirus has frozen before
    `main()` ever ran, and had to guess with a fixed timeout.
    """
    if not _verbose:
        return

    def _beat() -> None:
        started = time.monotonic()
        while True:
            time.sleep(interval_sec)
            try:
                elapsed = time.monotonic() - started
                print(f"{HEARTBEAT_PREFIX} {_stage} ({elapsed:.0f}s)", file=sys.stderr, flush=True)
            except Exception:
                return

    threading.Thread(target=_beat, daemon=True).start()

# Apply Python-level network sandbox before any engine imports
try:
    import sandbox as _sb; _sb.apply()
except Exception:
    pass  # sandbox failure must never crash the engine


def _writable_dir() -> Path:
    from paths import writable_dir  # noqa: PLC0415
    return writable_dir()


def ping(args):
    return {"pong": args, "status": "ok"}


def detect_device(_args):
    from device_detector import detect_device as _detect  # noqa: PLC0415
    return _detect()


def check_environment(args):
    """Ticket T3: full pre-flight self-check (Python, deps, GPU, RAM, disk).

    Returns a checklist rather than raising, so the UI can show which single
    item is broken instead of one opaque "training failed" at the end of a run.
    """
    from env_check import check_environment as _check  # noqa: PLC0415
    return _check(args)


def test_inference(_args):
    from inference import run_matmul_test  # noqa: PLC0415
    return run_matmul_test()


_synthesizer = None  # module-level cache; one process = one call, but avoids double-init


def _get_synthesizer(model_path: str | None = None):
    global _synthesizer
    from synthesizer import Synthesizer  # noqa: PLC0415
    # Always create a fresh instance when a specific path is requested
    if model_path:
        return Synthesizer(Path(model_path))
    if _synthesizer is None:
        _synthesizer = Synthesizer(Path(__file__).parent / "model.onnx")
    return _synthesizer


def synthesize(args):
    import numpy as np  # noqa: PLC0415
    params        = args[0] if args and isinstance(args[0], dict) else {}
    phonemes      = params.get("phonemes",      ["d", "o", "r", "e", "m", "i"])
    f0_hz         = params.get("f0_hz",         [294.0, 330.0, 370.0, 392.0, 440.0, 494.0])
    durations     = params.get("durations_sec", None)
    model_path    = params.get("model_path",    None)
    include_audio = params.get("include_audio", False)
    save_audio    = params.get("save_audio",    False)

    synth  = _get_synthesizer(model_path)
    result = synth.synthesize(phonemes, f0_hz, durations)
    audio  = np.array(result["audio"], dtype=np.float32)
    resp = {
        "duration_sec":   result["duration_sec"],
        "elapsed_ms":     result["elapsed_ms"],
        "ep":             result["ep"],
        "n_frames":       result["n_frames"],
        "sample_rate":    result["sample_rate"],
        "audio_samples":  len(audio),
        "rms":            round(float(np.sqrt(np.mean(audio ** 2))), 6),
        "max_abs":        round(float(np.max(np.abs(audio))), 6),
        "is_finite":      bool(np.all(np.isfinite(audio))),
        "passed":         bool(np.all(np.isfinite(audio)) and float(np.sqrt(np.mean(audio ** 2))) > 1e-4),
    }
    if include_audio:
        resp["audio"]       = result["audio"]
        resp["sample_rate"] = result["sample_rate"]
    if save_audio:
        import soundfile as _sf  # noqa: PLC0415
        out = _writable_dir() / f"demo_{int(time.time() * 1000)}.wav"
        _sf.write(str(out), audio, int(result["sample_rate"]), subtype="PCM_16")
        resp["audio_path"] = str(out)
    return resp


def benchmark_synthesis(args):
    """Synthesize `target_sec` of audio; pass if synthesis ≤ 30 % of real-time."""
    target_sec = float(args[0]) if args else 60.0

    from synthesizer import FRAME_RATE  # noqa: PLC0415
    # Five-vowel scale covering target_sec total
    vowels = ["a", "e", "i", "o", "u"]
    f0s    = [262.0, 294.0, 330.0, 349.0, 392.0]
    dur_each = target_sec / len(vowels)

    synth = _get_synthesizer()
    t0 = time.perf_counter()
    result = synth.synthesize(vowels, f0s, [dur_each] * len(vowels))
    elapsed = time.perf_counter() - t0

    actual   = result["duration_sec"]
    rt_ratio = elapsed / actual if actual > 0 else float("inf")
    return {
        "target_duration_sec": target_sec,
        "actual_duration_sec": actual,
        "elapsed_sec":         round(elapsed, 3),
        "real_time_ratio":     round(rt_ratio, 4),
        "ep":                  result["ep"],
        # acceptance: complete in ≤ 30 % of real-time
        "passed":              rt_ratio <= 0.30,
    }


def separate(args):
    """Separate audio stems; acceptance tests use a generated synthetic file."""
    import tempfile  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415
    from separation import separate as _sep  # noqa: PLC0415

    params      = args[0] if args and isinstance(args[0], dict) else {}
    mode        = params.get("mode", "standard")
    input_path  = params.get("input_path", None)
    duration    = float(params.get("duration_sec", 240.0))  # default: 4-minute test

    # Generate a synthetic test file when no real input is provided
    if input_path is None:
        n_samples  = int(44_100 * duration)
        t          = np.linspace(0, duration, n_samples, dtype=np.float32)
        # Two sine waves panned differently to simulate a stereo mix
        left  = 0.4 * np.sin(2 * np.pi * 440 * t) + 0.3 * np.sin(2 * np.pi * 880 * t)
        right = 0.3 * np.sin(2 * np.pi * 440 * t) + 0.4 * np.sin(2 * np.pi * 880 * t)
        stereo = np.stack([left, right], axis=1)   # [N, 2]

        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        sf.write(tmp.name, stereo, 44_100, subtype="PCM_16")
        input_path = tmp.name

    # FC-05: stream progress lines while the separation runs so the UI can
    # show a real percentage instead of an indefinite spinner. Written to
    # stdout ahead of the result, which both callers tolerate: the streaming
    # bridge forwards each line as an engine:progress event, and the plain
    # request/response bridge parses only the last line (the result).
    def _emit(percent, stage):
        print(json.dumps({"type": "separation_progress", "percent": percent, "stage": stage}),
              flush=True)

    result = _sep(input_path, mode=mode, progress_cb=_emit)

    # Crosstalk check for standard mode: stems must sum back to the mix
    crosstalk_db = None
    if mode == "standard":
        mix_audio, _  = sf.read(input_path, dtype="float32", always_2d=True)
        voc_audio, _  = sf.read(result["stems"]["vocals"],        dtype="float32", always_2d=True)
        acc_audio, _  = sf.read(result["stems"]["accompaniment"], dtype="float32", always_2d=True)
        n = min(len(mix_audio), len(voc_audio), len(acc_audio))
        residual = mix_audio[:n] - (voc_audio[:n] + acc_audio[:n])
        rms_res  = float(np.sqrt(np.mean(residual ** 2)))
        rms_mix  = float(np.sqrt(np.mean(mix_audio[:n] ** 2)))
        crosstalk_db = float(round(20.0 * float(np.log10(rms_res / rms_mix + 1e-12)), 2))

    return {
        "mode":           result["mode"],
        "stems":          result["stems"],
        "duration_sec":   result["duration_sec"],
        "elapsed_sec":    result["elapsed_sec"],
        "rt_ratio":       result["rt_ratio"],
        "crosstalk_db":   crosstalk_db,
        # acceptance: standard ≤ 10 s for 4 min; crosstalk < −40 dB
        "passed": bool(
            result["elapsed_sec"] <= (10.0 if mode == "standard" else 180.0)
            and (crosstalk_db is None or crosstalk_db < -40.0)
        ),
    }


def synthesize_cover(args):
    """
    Cover synthesis acceptance test.
    Generates 4-minute synthetic ref_vocal + accompaniment when no paths are given,
    then runs V1 and/or V2 and returns timing + expression metadata.
    """
    import tempfile  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    import soundfile as sf_mod  # noqa: PLC0415
    from cover_synthesis import synthesize_cover as _cover  # noqa: PLC0415

    params        = args[0] if args and isinstance(args[0], dict) else {}
    mode          = params.get("mode", "v1")
    duration      = float(params.get("duration_sec", 240.0))
    ai_model_path = params.get("ai_model", str(Path(__file__).parent / "model.onnx"))
    ref_path      = params.get("ref_vocal",      None)
    acc_path      = params.get("accompaniment",  None)

    sr_gen = 44_100
    n_samp = int(sr_gen * duration)
    t      = np.linspace(0, duration, n_samp, dtype=np.float32)

    # Generate synthetic inputs when real files are not provided
    if ref_path is None:
        ref_sig  = 0.5 * np.sin(2 * np.pi * 330 * t)
        # Add subtle vibrato to the reference so V2 has expression to capture
        vib      = 1.0 + 0.04 * np.sin(2 * np.pi * 5.0 * t)
        ref_sig  = (ref_sig * vib).astype(np.float32)
        tmp_ref  = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        sf_mod.write(tmp_ref.name, ref_sig, sr_gen, subtype="PCM_16")
        ref_path = tmp_ref.name

    if acc_path is None:
        acc_sig  = np.stack([
            0.3 * np.sin(2 * np.pi * 110 * t),
            0.3 * np.sin(2 * np.pi * 165 * t),
        ], axis=1).astype(np.float32)
        tmp_acc  = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        sf_mod.write(tmp_acc.name, acc_sig, sr_gen, subtype="PCM_16")
        acc_path = tmp_acc.name

    result = _cover(
        ai_model=ai_model_path,
        ref_vocal=ref_path,
        accompaniment=acc_path,
        mode=mode,
    )

    return {
        "mode":           result["mode"],
        "duration_sec":   result["duration_sec"],
        "elapsed_sec":    result["elapsed_sec"],
        "rt_ratio":       result["rt_ratio"],
        "vibrato_depth":  result["vibrato_depth"],
        "noise_reduction_db": result["noise_reduction_db"],
        "output_path":    result["output_path"],
        "ai_vocal_path":  result["ai_vocal_path"],
        "passed":         bool(result["passed"]),
    }


def pitch_shift(args):
    """Ticket 19: shift a target song's cached audio by up to ±12 semitones
    via librosa.effects.pitch_shift, caching the result under a writable
    scratch dir — see pitch_tools.shift_pitch."""
    from pitch_tools import shift_pitch  # noqa: PLC0415

    params     = args[0] if args and isinstance(args[0], dict) else {}
    input_path = params.get("input_path")
    if not input_path:
        return {"error": "input_path is required"}

    semitones = max(-12.0, min(12.0, float(params.get("semitones", 0))))
    cache_key = params.get("cache_key")

    return shift_pitch(input_path, semitones, cache_dir=_writable_dir() / "pitch-shift-cache", cache_key=cache_key)


def export_audio(args):
    """Save mixed PCM audio from the renderer to a file on disk.

    Ticket 44: the renderer used to send the rendered mix inline as a JSON
    sample array (`audio`), which flows through engine:call into the
    process argv. That's fine for a toy payload, but a real song is
    millions of samples — tens of MB of JSON text — and the OS caps a
    single argv string well below that (Linux MAX_ARG_STRLEN is ~128KB),
    so the engine process failed to even spawn and every real export
    failed. The renderer now writes the raw interleaved float32 PCM to a
    temp file and passes its path as `pcm_path`; `audio` is kept as a
    fallback for small/inline payloads (e.g. direct engine callers/tests).
    """
    import numpy as np  # noqa: PLC0415
    import soundfile as sf_mod  # noqa: PLC0415
    import os  # noqa: PLC0415

    params      = args[0] if args and isinstance(args[0], dict) else {}
    sample_rate = int(params.get("sample_rate", 44_100))
    channels    = int(params.get("channels", 1))
    output_path = params.get("output_path",
                             str(_writable_dir() / "_export.wav"))
    fmt         = params.get("format", "wav").lower()
    pcm_path    = params.get("pcm_path")

    if pcm_path:
        arr = np.fromfile(pcm_path, dtype="<f4")
        try:
            os.remove(pcm_path)   # best-effort — temp file, not needed after this
        except OSError:
            pass
    else:
        arr = np.array(params.get("audio", []), dtype=np.float32)

    if channels == 2 and len(arr.shape) == 1:
        arr = arr.reshape(-1, 2)   # interleaved → [N, 2]

    # soundfile supports wav, flac, ogg, aiff
    suffix_map = {"wav": "PCM_16", "flac": "PCM_24", "ogg": "VORBIS", "aiff": "PCM_16"}
    subtype    = suffix_map.get(fmt, "PCM_16")

    out_p = Path(output_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    if fmt not in suffix_map:
        # Unsupported format — fall back to WAV, rename extension
        out_p = out_p.with_suffix(".wav")
    sf_mod.write(str(out_p), arr, sample_rate, subtype=subtype)

    return {
        "output_path": str(out_p),
        "size_bytes":  int(os.path.getsize(out_p)),
        "format":      fmt if fmt in suffix_map else "wav",
        "duration_sec": round(len(arr) / sample_rate, 3),
    }


def train_model(args):
    """
    Run LoRA fine-tuning and stream JSON progress to the IPC caller.
    Acceptance: standard ≤ 20 min CPU; professional ≤ 90 min CPU.
    Uses synthetic dataset when data_dir is empty or omitted.
    """
    import re  # noqa: PLC0415
    from trainer import train as _train  # noqa: PLC0415

    params     = args[0] if args and isinstance(args[0], dict) else {}
    mode       = params.get("mode",   "standard")
    # Ticket T2: the UI resolves the device up front (and makes the user
    # confirm a CPU run), so honour its choice rather than re-picking here.
    # Anything unrecognised falls through to trainer's own auto-detection.
    device     = params.get("device") if params.get("device") in ("cuda", "mps", "cpu") else None
    epochs     = int(params.get("epochs",  10))   # small default for quick CI smoke-test
    batch_size = int(params.get("batch",   16))
    lr         = float(params.get("lr",    1e-4))
    data_dir   = Path(params.get("data_dir",
                                 str(_writable_dir() / "_test_data")))

    # Callers (the Training view) pass a client-generated model_id so each
    # trained model gets its own file. Without it, every "standard" run would
    # land on the same model_standard.onnx and silently clobber the previous
    # model — any UI card still pointing at that path would then load the
    # wrong voice with no error. Sanitised since it flows from the untrusted
    # IPC boundary into a filesystem path; falls back to the old fixed name
    # for direct engine callers (CLI/tests) that don't pass one.
    model_id   = params.get("model_id")
    if model_id:
        model_id = re.sub(r"[^A-Za-z0-9_-]", "", str(model_id))[:64]
    suffix     = f"_{model_id}" if model_id else ""
    output     = Path(params.get("output",
                                 str(_writable_dir() / f"model_{mode}{suffix}.onnx")))
    data_dir.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)

    result = _train(
        data_dir      = data_dir,
        output_path   = output,
        mode          = mode,
        epochs        = epochs,
        batch_size    = batch_size,
        lr            = lr,
        device        = device,
        progress_path = output.parent / f"progress_{mode}.json",
    )
    return {k: (bool(v) if isinstance(v, (bool,)) else v) for k, v in result.items()}


def apply_high_pitch_protection(args):
    """Ticket 17: clamp vocal pitch above the D#4 (MIDI 63) threshold down
    to exactly that note, returning the corrected regions for UI highlighting."""
    from pitch_protection import apply_high_pitch_protection as _protect  # noqa: PLC0415

    params         = args[0] if args and isinstance(args[0], dict) else {}
    audio_path     = params.get("audio_path")
    threshold_note = int(params.get("threshold_note", 63))
    output_path    = params.get("output_path")

    if not audio_path:
        return {"error": "audio_path is required"}

    result = _protect(audio_path, threshold_note=threshold_note, output_path=output_path)
    return dict(result)


def watermark_embed(args):
    """Embed a blind watermark into audio returned by a previous synthesize call."""
    import numpy as np  # noqa: PLC0415
    from watermark import Watermarker  # noqa: PLC0415

    params    = args[0] if args and isinstance(args[0], dict) else {}
    audio     = np.array(params.get("audio", []), dtype=np.float32)
    uid       = str(params.get("uid", "anonymous"))
    timestamp = int(params.get("timestamp", int(time.time())))

    if len(audio) == 0:
        return {"error": "audio array is empty"}

    model_path = Path(__file__).parent / "watermark_embed.onnx"
    wm = Watermarker(model_path)
    watermarked = wm.embed(audio, uid, timestamp)

    snr_db = float(
        20 * np.log10(
            np.linalg.norm(audio) /
            (np.linalg.norm(watermarked - audio) + 1e-8)
        )
    )
    return {
        "audio":     watermarked.tolist(),
        "uid":       uid,
        "timestamp": timestamp,
        "snr_db":    round(snr_db, 2),
        "samples":   len(watermarked),
    }


def watermark_verify(args):
    """Verify watermark presence in audio; blind (original not required)."""
    import numpy as np  # noqa: PLC0415
    from watermark import Watermarker  # noqa: PLC0415

    params    = args[0] if args and isinstance(args[0], dict) else {}
    audio     = np.array(params.get("audio", []), dtype=np.float32)
    uid       = str(params.get("uid", "anonymous"))
    timestamp = int(params.get("timestamp", 0))

    if len(audio) == 0:
        return {"error": "audio array is empty"}

    model_path = Path(__file__).parent / "watermark_embed.onnx"
    wm     = Watermarker(model_path)
    result = wm.verify(audio, uid, timestamp)
    return dict(result)


def encrypt_model(args):
    """Encrypt a model ONNX file → .enc using AES-256-GCM."""
    from model_crypto import encrypt_file  # noqa: PLC0415

    params   = args[0] if args and isinstance(args[0], dict) else {}
    src      = Path(params.get("model_path", ""))
    key_hex  = str(params.get("key_hex", ""))
    dst_str  = params.get("output_path", None)
    dst      = Path(dst_str) if dst_str else None

    if not src.exists():
        return {"error": f"model file not found: {src}"}
    if len(key_hex) != 64:
        return {"error": "key_hex must be 64 hex chars (32 bytes)"}

    enc_path = encrypt_file(src, key_hex, dst)
    return {
        "enc_path":    str(enc_path),
        "size_bytes":  enc_path.stat().st_size,
        "encrypted":   True,
    }


def analyze_pitch(args):
    """Ticket 16: extract the pitch contour of a region (or the whole track)
    and report the highest note found, for the "分析音高" button.
    """
    from pitch_analysis import analyze_pitch as _analyze  # noqa: PLC0415

    params     = args[0] if args and isinstance(args[0], dict) else {}
    audio_path = params.get("audio_path", None)
    start_sec  = params.get("start_sec", None)
    end_sec    = params.get("end_sec", None)

    if not audio_path:
        return {"error": "audio_path is required"}

    try:
        return _analyze(audio_path, start_sec, end_sec)
    except Exception as exc:
        # Matches the other file-processing handlers (decrypt_model, etc.):
        # surface a clean {"error": ...} the renderer can show, instead of
        # letting a bad/corrupt file or missing codec raise all the way out
        # to a non-zero exit + raw Python traceback on stderr.
        return {"error": str(exc)}


def decrypt_model(args):
    """Decrypt a .enc model file and verify it loads into ORT (in-memory only)."""
    from model_crypto import load_encrypted_session  # noqa: PLC0415

    params   = args[0] if args and isinstance(args[0], dict) else {}
    enc_path = Path(params.get("enc_path", ""))
    key_hex  = str(params.get("key_hex", ""))

    if not enc_path.exists():
        return {"error": f"encrypted model not found: {enc_path}"}
    if len(key_hex) != 64:
        return {"error": "key_hex must be 64 hex chars"}

    try:
        sess = load_encrypted_session(enc_path, key_hex)
        inputs  = [i.name for i in sess.get_inputs()]
        outputs = [o.name for o in sess.get_outputs()]
        return {
            "decrypted":    True,
            "enc_path":     str(enc_path),
            "inputs":       inputs,
            "outputs":      outputs,
        }
    except Exception as exc:
        return {"decrypted": False, "error": str(exc)}


def _task_dir(task_id) -> Path:
    """Per-task scratch dir under the writable dir, e.g. for a merge/upload
    run's protected vocal, shifted target, merged_train.wav and zip to all
    land together (Ticket 20). Sanitised the same way train_model()
    sanitises model_id — this flows from the untrusted IPC boundary into a
    filesystem path."""
    import re  # noqa: PLC0415
    safe = re.sub(r"[^A-Za-z0-9_-]", "", str(task_id or ""))[:64] or "adhoc"
    d = _writable_dir() / "train_datasets" / safe
    d.mkdir(parents=True, exist_ok=True)
    return d


def merge_train_audio(args):
    """Ticket 20: merge the (high-pitch-protected) vocal and the
    (pitch-shifted) target song into a single merged_train.wav."""
    from train_dataset import merge_train_audio as _merge  # noqa: PLC0415

    params      = args[0] if args and isinstance(args[0], dict) else {}
    vocal_path  = params.get("vocal_path")
    target_path = params.get("target_path")
    if not vocal_path or not target_path:
        return {"error": "vocal_path and target_path are required"}

    output_path = params.get("output_path") or str(_task_dir(params.get("task_id")) / "merged_train.wav")
    return _merge(
        vocal_path, target_path, output_path,
        align_mode=params.get("align_mode", "pad"),
        include_dry_vocal=bool(params.get("include_dry_vocal", False)),
        dry_vocal_path=params.get("dry_vocal_path"),
    )


def package_train_dataset(args):
    """Ticket 20: zip merged_train.wav (+ optional dry vocal) for upload."""
    from train_dataset import package_train_dataset as _package  # noqa: PLC0415

    params = args[0] if args and isinstance(args[0], dict) else {}
    files  = params.get("files") or []
    if not files:
        return {"error": "files is required"}

    output_zip_path = params.get("output_zip_path") or str(_task_dir(params.get("task_id")) / "train_dataset.zip")
    return _package(files, output_zip_path)


HANDLERS = {
    "ping":                        ping,
    "detect_device":               detect_device,
    # Ticket T3: pre-flight environment self-check shown before training starts.
    "check_environment":           check_environment,
    "test_inference":              test_inference,
    "synthesize":                  synthesize,
    "benchmark_synthesis":         benchmark_synthesis,
    "separate":                    separate,
    "synthesize_cover":            synthesize_cover,
    "export_audio":                export_audio,
    "train_model":                 train_model,
    "watermark_embed":             watermark_embed,
    "watermark_verify":            watermark_verify,
    "encrypt_model":               encrypt_model,
    "decrypt_model":               decrypt_model,
    # Ticket 17 (already on main): 强制修音 high-pitch protection.
    "apply_high_pitch_protection": apply_high_pitch_protection,
    # Ticket 16 (already on main): pitch analysis ("分析音高").
    "analyze_pitch":               analyze_pitch,
    # Ticket 19 (already on main): pitch shift / Tune slider — see
    # pitch_tools.shift_pitch.
    "pitch_shift":                 pitch_shift,
    # Ticket 20 (this branch): merge/package for the training-dataset
    # upload flow — see train_dataset.py. Reuses Ticket 17's
    # apply_high_pitch_protection and Ticket 19's pitch_shift above.
    "merge_train_audio":           merge_train_audio,
    "package_train_dataset":       package_train_dataset,
}


def main() -> None:
    global _verbose, _stage

    argv = sys.argv[1:]
    if "--verbose" in argv:
        _verbose = True
        argv = [a for a in argv if a != "--verbose"]

    # Emitted before anything else so the bridge learns the process is alive
    # the moment it starts, instead of after the first heavy import returns.
    _log(f"engine started (pid {os.getpid()}, python {sys.version.split()[0]})")
    _start_heartbeat()

    if not argv:
        _fail("no payload provided")

    try:
        payload = json.loads(argv[-1])
    except json.JSONDecodeError as exc:
        _fail(f"invalid JSON payload: {exc}")

    method = payload.get("method")
    args = payload.get("args", [])

    handler = HANDLERS.get(method)
    if handler is None:
        _fail(f"unknown method: {method!r}")

    _stage = f"running {method}"
    _log(f"dispatching {method}")
    started = time.monotonic()
    try:
        result = handler(args)
    except Exception as exc:
        # Previously this propagated as a bare traceback and exit code 1,
        # which reached the user as an unparseable wall of text. Keep the
        # traceback in the verbose log, but exit through _fail so the bridge
        # still gets a structured {"error": ...}.
        if _verbose:
            import traceback  # noqa: PLC0415
            _log("handler raised:\n" + traceback.format_exc())
        _fail(f"{method} failed: {exc}")
        return
    _stage = "writing result"
    _log(f"{method} finished in {time.monotonic() - started:.2f}s")
    print(json.dumps(result))


def _fail(msg: str) -> None:
    print(json.dumps({"error": msg}), file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
