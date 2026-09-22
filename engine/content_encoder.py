"""
Speaker-invariant content features, from a pretrained ContentVec encoder.

Why this exists. voice_model's own content is the excitation — the spectrum
with its cepstral envelope divided out — which is *approximately*
speaker-independent and, it turns out, not nearly enough. Measured on four
pairs of real speakers (LibriSpeech dev-clean, 60 s of training material,
converting one person's speech towards another's timbre; third-octave
log-spectrum distance, lower is closer to the target):

                         to target   worst   diction
    reference untouched      1.16       —      1.00
    static average envelope  0.68     0.97     0.67
    excitation content       1.01     1.63     0.88
    ContentVec content       0.78     1.47     0.90

The excitation decoder does essentially nothing between two real people: 1.01
against 1.16 for leaving the voice alone. The synthetic fixtures it was built
against were two colourings of one excitation generator, so the excitation
really was speaker-independent there — the test flattered exactly the weakness
it should have caught.

ContentVec closes most of that gap and keeps the diction the static envelope
costs (0.90 against 0.67). It does not win everywhere: on one of the four
pairs it scored 1.47 where the static envelope scored 0.62. That is why
trainer._decoder_beats_envelope still decides per model whether the decoder
ships at all — see its docstring. This encoder makes the learned path worth
having, not automatic.

The weights. `lengyue233/content-vec-best`, MIT, a transformers port of
ContentVec (Qian et al.), itself a HuBERT trained with a speaker-disentangling
objective — which is the property being bought here and is not something a
normalisation gets you: cepstral mean and variance normalisation of the
excitation cuts measured speaker leakage fivefold and still loses, because it
removes more of the content than of the singer.

Deliberately *not* the ready-made ONNX conversions: the MoeSS ones are GPL-3.0
and this is a closed-source product; the Xenova ones state no license at all.
scripts/fetch-models.sh downloads the MIT checkpoint and converts it, so the
license of what ships is the license of what was downloaded.

Six transformer layers, not twelve. On the same four pairs the depths measured
0.78 (6), 0.77 (9) and 0.79 (12) — indistinguishable against a pair-to-pair
spread of 0.28 to 1.47 — so the 207 MB one ships rather than the 378 MB one.

Absent weights are not an error. A source checkout and CI have no encoder, and
voice_model falls back to excitation content; a model trained against one
content format refuses to load under the other, so the two never mix.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np

MODEL_NAME = "contentvec-base-L6.onnx"

# The rate ContentVec was trained at. Everything is resampled to this before
# encoding; it has nothing to do with the rates the rest of the engine uses.
ENCODER_SR: int = 16_000

# Output width, and the frame rate that comes with it: HuBERT's convolutional
# front end strides by 320 samples, so 16000/320 = 50 frames per second.
DIM: int = 768
FRAME_RATE: float = ENCODER_SR / 320.0

# Self-attention is quadratic in sequence length, so a whole song in one call
# grows the cost faster than its duration: 10 s takes 0.3 s and 30 s takes
# 1.4 s, already more than three times as much. Encoding in windows keeps it
# linear. The overlap is dropped from each window's edges, where the missing
# context would otherwise show as a seam.
CHUNK_SEC: float = 20.0
OVERLAP_SEC: float = 1.0

_SESSION = None
_SESSION_PATH: Path | None = None


def model_path(engine_dir: Path | None = None) -> Path:
    return (engine_dir or Path(__file__).parent) / MODEL_NAME


def is_available(engine_dir: Path | None = None) -> bool:
    """True when the encoder weights are present.

    False in a source checkout that has not run scripts/fetch-models.sh, and
    in CI. Callers fall back to excitation content rather than failing.
    """
    return model_path(engine_dir).exists()


def _session(engine_dir: Path | None = None):
    """The ORT session, created once. A 207 MB session per call would cost
    more than the encoding."""
    global _SESSION, _SESSION_PATH
    import onnxruntime as ort  # noqa: PLC0415

    path = model_path(engine_dir)
    if _SESSION is None or _SESSION_PATH != path:
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = min(os.cpu_count() or 4, 8)
        _SESSION = ort.InferenceSession(str(path), sess_options=opts,
                                        providers=["CPUExecutionProvider"])
        _SESSION_PATH = path
    return _SESSION


def encode(audio: np.ndarray, sr: int, engine_dir: Path | None = None) -> np.ndarray:
    """Mono audio at `sr` -> content features [DIM, frames] at FRAME_RATE.

    Raises FileNotFoundError when the weights are absent; call is_available()
    first.
    """
    from voice_model import resample_for_content  # noqa: PLC0415

    if not is_available(engine_dir):
        raise FileNotFoundError(
            f"{MODEL_NAME} is not in {model_path(engine_dir).parent}. "
            "Run scripts/fetch-models.sh, or let voice_model fall back to "
            "excitation content.")

    wav = np.asarray(resample_for_content(audio, sr, ENCODER_SR), dtype=np.float32)
    session = _session(engine_dir)
    name = session.get_inputs()[0].name

    chunk = int(CHUNK_SEC * ENCODER_SR)
    overlap = int(OVERLAP_SEC * ENCODER_SR)
    if len(wav) <= chunk:
        return session.run(None, {name: wav[None]})[0][0].T

    pieces: list[np.ndarray] = []
    step = chunk - 2 * overlap
    for start in range(0, len(wav), step):
        lo = max(0, start - overlap)
        hi = min(len(wav), start + step + overlap)
        if hi - lo < 640:                    # shorter than two output frames
            break
        out = session.run(None, {name: wav[lo:hi][None]})[0][0].T     # [DIM, t]
        # Trim the frames that came from the overlap, so each sample of the
        # input contributes to exactly one output frame.
        head = round((start - lo) / ENCODER_SR * FRAME_RATE)
        want = round((min(hi, start + step) - start) / ENCODER_SR * FRAME_RATE)
        pieces.append(out[:, head: head + want])
        if hi >= len(wav):
            break
    return np.concatenate(pieces, axis=1) if pieces else np.zeros((DIM, 0), np.float32)
