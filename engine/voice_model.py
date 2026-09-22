"""
Learned per-frame timbre decoder — the part of the model training actually
moves.

What training used to do: `target = frames.flatten(...)` against a model whose
weights start at 0.98 x identity. The objective was *reproduce your own
input*, and the initialisation already solved it. Measured over 30 epochs the
loss went 2.2e-05 -> 1.9e-05, a 13% move on a quantity that was already
negligible, and none of it was about the singer. That is why a thirty-minute
training run changed nothing an ear could hear, and why a GPU would not have
helped: a faster machine solves the same trivial problem faster.

What it does now. A voice factors, usefully, into

    spectrum  =  excitation  x  spectral envelope

(see timbre.py). The excitation carries pitch, words, consonants and timing;
the envelope carries who is singing. So take the envelope *off* the input and
ask the model to put it back:

    content  =  mel(log excitation) + log f0 + voiced      [82, T]
    target   =  level-free log-mel envelope                [80, T]

The timbre is removed from the input and *is* the target, so the task cannot
be solved by copying — the only place the answer can live is the weights.
That is the whole difference from what was there before.

Measured through the real train-then-cover pipeline, against a target singer
2.90 away from the reference (third-octave log-spectrum distance, 350 Hz -
8 kHz; two takes of one singer measure 0.19 apart, which is the floor):

                                    to target   diction   vowel movement
    reference, untouched                 2.90      1.00        100%
    timbre.py's static envelope          0.65      0.95         62%
    this decoder                         0.56      0.99         86%

The static envelope is one colour for a whole singer, so every frame gets the
same one and vowels flatten towards each other — the same defect as the
hardcoded single vowel it replaced, just smaller. This predicts an envelope
per frame from that frame's content, so the vowels survive, and it is closer
to the target as well.

Honest limit, and it is the reason this is a step rather than an answer: the
excitation is only *approximately* speaker-independent. Envelope removal
leaves some of the source singer in it, so the conversion is pulled towards
whoever sang the reference. The measurements above use two synthetic voices
built from one excitation generator, which flatters exactly that weakness;
real singers differ in glottal source too and the gap will be larger. The
fix is a content encoder trained to be speaker-invariant (ContentVec and the
RVC family, both MIT-licensed) in place of `content_features` here. The
feature contract is kept narrow for that swap: everything downstream takes
[C, T] and does not care how it was produced, and CONTENT_VERSION_* below
makes the swap safe for models trained before it. That swap has since
happened: see content_encoder, which supplies the content whenever its
weights are installed.

Three cheaper substitutes were measured first and none of them works, which
is why the encoder is not optional. Against a baseline of 0.28 / 0.39 / 0.28 (at 100,
400 and 1000 epochs; a static average envelope scores 0.52 on the same
fixture and the measurement floor is 0.20):

    formant-warp augmentation of the content   0.39 / 0.29 / 0.76
    cepstral mean normalisation (CMN)          0.51 / 0.54 / 0.46
    mean + variance normalisation (CMVN)       0.39 / 0.36 / 0.37

CMVN is the interesting failure. Measured directly — one performance coloured
as two different singers — it cuts what leaks into the content fivefold, from
0.046 of the timbre difference to 0.009, and it visibly steadies the result
across training lengths. It still loses, because per-dimension normalisation
removes more of the content than it removes of the singer. Speaker-invariance
that keeps the content is what ContentVec was trained to do, and it does not
fall out of a normalisation.

Inference runs in numpy rather than ONNX Runtime. Three convolutions over a
few thousand frames is under a millisecond, and keeping it out of the graph
means the trained decoder can ride inside the existing .onnx as initializers
— one file for model_crypto to encrypt and one entry for the library UI —
without disturbing the synthesiser graph main.py still loads.
"""
from __future__ import annotations

import numpy as np

from timbre import cepstrum_order, spectral_envelope

# Analysis is fixed at the training rate. The envelope this predicts is a
# function of absolute frequency, so cover synthesis interpolates it onto its
# own rate by Hz — never by bin index, which is the octave error timbre.py's
# resample_envelope docstring records.
SR: int = 22_050
N_FFT: int = 1024
HOP: int = 256
N_MEL: int = 80

# content = N_MEL log-excitation bands + log f0 + voiced flag
N_CONTENT: int = N_MEL + 2

F0_MIN: float = 70.0
F0_MAX: float = 700.0

_EPS = 1e-8


def _mel_filterbank(n_mel: int = N_MEL, n_fft: int = N_FFT, sr: int = SR,
                    fmin: float = 40.0) -> tuple[np.ndarray, np.ndarray]:
    """Triangular mel filterbank and its band centre frequencies in Hz.

    The centres are returned because they, not the band indices, are what
    makes the predicted envelope meaningful at another sample rate.
    """
    fmax = sr / 2.0
    to_mel = lambda f: 2595.0 * np.log10(1.0 + f / 700.0)       # noqa: E731
    to_hz = lambda m: 700.0 * (10.0 ** (m / 2595.0) - 1.0)      # noqa: E731
    points = to_hz(np.linspace(to_mel(fmin), to_mel(fmax), n_mel + 2))
    bins = np.linspace(0.0, sr / 2.0, n_fft // 2 + 1)
    fb = np.zeros((n_mel, len(bins)))
    for i in range(n_mel):
        lo, centre, hi = points[i], points[i + 1], points[i + 2]
        fb[i] = np.clip(np.minimum((bins - lo) / (centre - lo + 1e-9),
                                   (hi - bins) / (hi - centre + 1e-9)), 0.0, None)
    fb /= (fb.sum(axis=1, keepdims=True) + 1e-9)
    return fb, points[1:-1]


MEL_FB, MEL_HZ = _mel_filterbank()


def stft(audio: np.ndarray, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    """[N] -> [bins, frames], periodic Hann, reflect-padded."""
    window = np.hanning(n_fft + 1)[:-1]
    audio = np.asarray(audio, dtype=np.float64)
    pad = n_fft // 2
    padded = np.pad(audio, (pad, pad), mode="reflect")
    n_frames = 1 + (len(padded) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n_frames)[:, None]
    return np.fft.rfft(padded[idx] * window, axis=-1).T


def istft(spec: np.ndarray, length: int, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    """Weighted overlap-add inverse of :func:`stft`."""
    window = np.hanning(n_fft + 1)[:-1]
    n_frames = spec.shape[1]
    frames = np.fft.irfft(spec.T, n=n_fft, axis=-1) * window
    acc = np.zeros((n_frames - 1) * hop + n_fft)
    weight = np.zeros_like(acc)
    for i in range(n_frames):
        acc[i * hop: i * hop + n_fft] += frames[i]
        weight[i * hop: i * hop + n_fft] += window ** 2
    pad = n_fft // 2
    return (acc / np.maximum(weight, 1e-10))[pad: pad + length]


def estimate_f0(mag: np.ndarray, sr: int = SR) -> tuple[np.ndarray, np.ndarray]:
    """Harmonic-product-spectrum f0 and a voiced flag, per frame.

    Deliberately cheap. f0 enters the content as one number per frame, where
    it tells the decoder which register the singer is in — a vocal tract does
    not resonate the same way at the top of a range as at the bottom. It is
    not used for resynthesis, so an occasional octave error costs accuracy in
    the conditioning rather than a wrong note in the output.
    """
    hz = np.linspace(0.0, sr / 2.0, mag.shape[0])
    hps = mag.copy()
    for k in (2, 3):
        decimated = mag[::k]
        hps[:len(decimated)] *= decimated
    band = (hz >= F0_MIN) & (hz <= F0_MAX)
    f0 = hz[np.argmax(np.where(band[:, None], hps, 0.0), axis=0)]
    energy = mag.sum(axis=0)
    voiced = (energy > np.percentile(energy, 35)).astype(np.float64)
    return f0 * voiced, voiced


def resample_for_content(audio: np.ndarray, sr_in: int, sr_out: int = SR) -> np.ndarray:
    """Band-limited resampling, for getting a cover-rate reference down to SR.

    This has to be band-limited and the plain linear interpolation next door
    in cover_synthesis is not. Going 44.1 kHz -> 22.05 kHz, linear
    interpolation folds everything above 11 kHz back into the band, so the
    decoder sees content with a spectrum it never met in training — its
    training material is already at SR and was never aliased. Measured, that
    mismatch alone cost more than everything else in this file put together:
    the converted vocal sat 1.20 from the target through linear interpolation
    and 0.61 through this, against 0.65 for the static average envelope. It
    was the difference between the decoder losing to the envelope it replaces
    and beating it.

    Done in the frequency domain: truncating the spectrum *is* the ideal
    low-pass, and at one FFT over the reference it costs less than designing
    a filter would.
    """
    audio = np.asarray(audio, dtype=np.float64)
    if sr_in == sr_out or len(audio) == 0:
        return audio.astype(np.float32)
    n_in = len(audio)
    n_out = max(1, int(round(n_in * sr_out / sr_in)))
    spec = np.fft.rfft(audio)
    keep = min(len(spec), n_out // 2 + 1)
    # irfft normalises by its own length, so rescale to keep the amplitude.
    out = np.fft.irfft(spec[:keep], n=n_out) * (n_out / n_in)
    return out.astype(np.float32)


def _excitation_content(audio: np.ndarray) -> np.ndarray:
    """Content as mel(log excitation) + log f0 + voiced, [N_CONTENT, T].

    The excitation — magnitude divided by its own cepstral envelope — is what
    is left of a voice once its timbre is taken away. Only approximately, and
    the approximation is the whole problem: between two real speakers this
    carries enough of the source that a decoder driven by it converts almost
    nothing. See content_encoder for the measurements and the replacement.
    """
    spec = stft(audio)
    mag = np.abs(spec)
    env = spectral_envelope(mag, cepstrum_order(SR))
    excitation = mag / (env + _EPS)
    f0, voiced = estimate_f0(mag)
    return np.concatenate([
        np.log(MEL_FB @ excitation + _EPS),
        np.log(f0 + 1.0)[None, :],
        voiced[None, :],
    ], axis=0)


def _resample_rows(rows: np.ndarray, n: int) -> np.ndarray:
    """Stretch [C, T] onto [C, n] along time."""
    if rows.shape[1] == n:
        return rows
    src = np.linspace(0.0, 1.0, rows.shape[1])
    dst = np.linspace(0.0, 1.0, n)
    return np.stack([np.interp(dst, src, row) for row in rows])


def content_features(audio: np.ndarray, engine_dir=None) -> np.ndarray:
    """Speaker-independent content of a mono signal at SR, as [C, T].

    ContentVec when its weights are installed, excitation otherwise, with the
    pitch appended either way — the encoder is trained to discard exactly the
    information that says which note is being sung, and the decoder needs it
    back to know which register the vocal tract is in.

    The two paths emit different widths, which is safe because
    current_content_version() moves with them and a decoder is only loaded
    against the format it was trained on.

    ContentVec runs at 50 frames per second and the envelope this drives is at
    SR/HOP (86.13); the features are stretched onto that grid rather than the
    decoder being rebuilt around the encoder's rate, so one decoder
    architecture serves both content paths.
    """
    import content_encoder  # noqa: PLC0415

    spec = stft(audio)
    mag = np.abs(spec)
    if not content_encoder.is_available(engine_dir):
        return _excitation_content(audio)

    f0, voiced = estimate_f0(mag)
    cv = content_encoder.encode(audio, SR, engine_dir)
    pitch = np.stack([np.log(f0 + 1.0), voiced])
    n = mag.shape[1]
    return np.concatenate([_resample_rows(cv, n), _resample_rows(pitch, n)], axis=0)


def target_envelope(audio: np.ndarray) -> np.ndarray:
    """The singer's timbre, as a level-free log-mel envelope [N_MEL, T].

    Mean-removed per frame so the decoder learns colour and not loudness: the
    reference's own dynamics are kept at resynthesis, and a model that also
    predicted level would fight them.
    """
    env = spectral_envelope(np.abs(stft(audio)), cepstrum_order(SR))
    mel = np.log(MEL_FB @ env + _EPS)
    return mel - mel.mean(axis=0, keepdims=True)


# ── the decoder ───────────────────────────────────────────────────────────────

# Hidden width per training mode. Standard fits a CPU; professional is the
# reason the training path wants a GPU at all — see trainer.estimate_training.
HIDDEN_STANDARD: int = 256
HIDDEN_PROFESSIONAL: int = 512

# Receptive field of 9 frames ~ 105 ms at this hop, which spans a syllable:
# a vocal tract's shape at one instant depends on what it is moving towards.
KERNEL: int = 5
N_LAYERS: int = 3

WEIGHT_PREFIX = "timbre_decoder."

# Which content-feature format a stored decoder was trained against.
#
# A decoder is only meaningful with the features it learned from, and those
# are going to change: content_features here is excitation with the envelope
# lifted off, which is only approximately speaker-independent, and the plan is
# to replace it with an encoder trained to be speaker-invariant (ContentVec
# and the RVC family). The day that lands, every model already in a user's
# library was trained against this format.
#
# Without a tag the mismatch surfaces as a ValueError from a reshape deep in
# predict_envelope, i.e. the cover feature breaking with no explanation on a
# model that used to work. With one, cover synthesis recognises the model as
# older, falls back to the average envelope stored beside the decoder — which
# is just a spectrum and does not care how content is computed — and says so
# in CoverResult.timbre_source.
#
# Bump this whenever content_features changes what it emits: the dimensions,
# their order, their scaling, the mel band layout, or the f0 encoding.
CONTENT_VERSION_EXCITATION: int = 1   # mel(log excitation) + log f0 + voiced
CONTENT_VERSION_CONTENTVEC: int = 2   # ContentVec + log f0 + voiced

CONTENT_VERSION_KEY = WEIGHT_PREFIX + "content_version"


def current_content_version(engine_dir=None) -> int:
    """Which content format this build produces right now.

    Not a constant, because it depends on whether the encoder weights are
    installed: with them content_features returns ContentVec, without them
    excitation. A decoder trained against one is meaningless driven by the
    other, so this is what decoder_is_usable compares against — a model
    trained on a machine with the encoder simply reads as "no decoder" on one
    without it, and cover synthesis falls back to the average envelope.
    """
    import content_encoder  # noqa: PLC0415

    return (CONTENT_VERSION_CONTENTVEC if content_encoder.is_available(engine_dir)
            else CONTENT_VERSION_EXCITATION)


def content_width(engine_dir=None) -> int:
    """Rows content_features emits for this build."""
    import content_encoder  # noqa: PLC0415

    return ((content_encoder.DIM + 2) if content_encoder.is_available(engine_dir)
            else N_CONTENT)


def build_torch_decoder(hidden: int = HIDDEN_STANDARD, c_in: int | None = None):
    """The PyTorch module trained in trainer.py. Imported lazily: inference
    never needs torch, and the packaged app ships without it.

    `c_in` defaults to whatever content_features emits for this build, which
    is 770 with the ContentVec encoder installed and 82 without it.
    """
    import torch.nn as nn  # noqa: PLC0415

    if c_in is None:
        c_in = content_width()
    return nn.Sequential(
        nn.Conv1d(c_in, hidden, KERNEL, padding=KERNEL // 2), nn.GELU(),
        nn.Conv1d(hidden, hidden, KERNEL, padding=KERNEL // 2), nn.GELU(),
        nn.Conv1d(hidden, N_MEL, 1),
    )


def decoder_state_to_arrays(module) -> dict[str, np.ndarray]:
    """Trained weights as plain arrays, named for storage in the .onnx.

    Carries the content format with them, because weights without the
    features they were trained on cannot be used safely.
    """
    arrays = {f"{WEIGHT_PREFIX}{k}": v.detach().cpu().numpy().astype(np.float32)
              for k, v in module.state_dict().items()}
    arrays[CONTENT_VERSION_KEY] = np.array([current_content_version()], dtype=np.float32)
    return arrays


def decoder_is_usable(weights: dict[str, np.ndarray]) -> bool:
    """Can this build's content features drive these stored weights?

    Two ways to be sure, because models exist that predate the version tag:

      * the tag, when present, must match current_content_version() exactly;
      * failing that, the first layer's input width must be N_CONTENT.

    The shape check is what covers models trained before this tag existed. It
    is weaker — two formats can share a width — which is why the tag is
    written now, so the next change has something exact to compare against.
    """
    required = {f"{WEIGHT_PREFIX}{i}.{w}" for i in (0, 2, 4) for w in ("weight", "bias")}
    if not required <= set(weights):
        return False
    tagged = weights.get(CONTENT_VERSION_KEY)
    if tagged is not None:
        return int(np.asarray(tagged).ravel()[0]) == current_content_version()
    # Untagged models predate the tag and are all excitation-format, so they
    # are usable only while this build is producing that format too.
    first = weights[f"{WEIGHT_PREFIX}0.weight"]
    return (current_content_version() == CONTENT_VERSION_EXCITATION
            and first.ndim == 3 and first.shape[1] == N_CONTENT)


def _conv1d(x: np.ndarray, w: np.ndarray, b: np.ndarray) -> np.ndarray:
    """[C_in, T] -> [C_out, T], 'same' padding, matching nn.Conv1d.

    Written out rather than pulled from a library because it is the only
    tensor op inference needs, and adding a framework dependency for three
    convolutions would cost more than it saves.
    """
    c_out, c_in, k = w.shape
    pad = k // 2
    t = x.shape[1]
    xp = np.pad(x, ((0, 0), (pad, pad)))
    # Fold the kernel taps into the channel axis so the convolution becomes a
    # single GEMM: [C_out, C_in*k] @ [C_in*k, T]. einsum over the same
    # operands does not reach BLAS and ran ~4x slower on a full song.
    win = np.stack([xp[:, i: i + t] for i in range(k)], axis=1).reshape(c_in * k, t)
    return w.reshape(c_out, c_in * k) @ win + b[:, None]


def _gelu(x: np.ndarray) -> np.ndarray:
    """Exact GELU, matching nn.GELU's default.

    The tanh approximation was close — 3e-05 on an untrained module — but the
    error grows with the weights, and on a trained decoder it reached 1.7e-03.
    That is still inaudible, and it is still the exported model quietly not
    being the model that was trained. math.erf is vectorised here through
    numpy's own erf-free formulation so this needs no scipy.
    """
    return 0.5 * x * (1.0 + _erf(x / np.sqrt(2.0)))


def _erf(x: np.ndarray) -> np.ndarray:
    """Vectorised erf, Abramowitz & Stegun 7.1.26.

    numpy has no erf and scipy is not a dependency here. math.erf through
    np.vectorize is a Python loop — 125 ms for 3 s of audio, so ten seconds
    on a full song — where this is one pass of arithmetic. Absolute error is
    below 1.5e-07, four orders under the float32 the weights are stored in.
    """
    a = (0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429)
    p = 0.3275911
    sign = np.sign(x)
    z = np.abs(x)
    t = 1.0 / (1.0 + p * z)
    poly = t * (a[0] + t * (a[1] + t * (a[2] + t * (a[3] + t * a[4]))))
    return sign * (1.0 - poly * np.exp(-z * z))


def predict_envelope(weights: dict[str, np.ndarray], content: np.ndarray) -> np.ndarray:
    """Run the decoder in numpy: content [N_CONTENT, T] -> log-mel envelope."""
    x = np.asarray(content, dtype=np.float32)
    if x.shape[0] != weights[f"{WEIGHT_PREFIX}0.weight"].shape[1]:
        raise ValueError(
            f"content has {x.shape[0]} rows but this decoder was trained on "
            f"{weights[f'{WEIGHT_PREFIX}0.weight'].shape[1]}. Callers should "
            f"screen with decoder_is_usable() rather than reach this.")
    # state_dict keys are "0.weight", "2.weight", "4.weight" — the GELUs at
    # indices 1 and 3 carry no parameters.
    for i, layer in enumerate((0, 2, 4)):
        x = _conv1d(x, weights[f"{WEIGHT_PREFIX}{layer}.weight"],
                    weights[f"{WEIGHT_PREFIX}{layer}.bias"])
        if i < 2:
            x = _gelu(x)
    return x


def mel_envelope_to_linear(mel_env: np.ndarray, n_bins: int, dst_sr: int) -> np.ndarray:
    """[N_MEL, T] -> [n_bins, T] on a linear grid at `dst_sr`.

    Interpolated against absolute frequency. Mel band centres are Hz, so this
    is correct at any output rate; interpolating by index would repeat the
    octave error that made the first version of envelope transfer move every
    formant up a fifth. Above the analysis Nyquist there is no measurement, so
    the last band holds rather than extrapolating.
    """
    hz = np.linspace(0.0, dst_sr / 2.0, n_bins)
    return np.stack([np.interp(hz, MEL_HZ, mel_env[:, t],
                               left=mel_env[0, t], right=mel_env[-1, t])
                     for t in range(mel_env.shape[1])], axis=1)


def convert(audio: np.ndarray, weights: dict[str, np.ndarray],
            strength: float = 1.0) -> np.ndarray:
    """Re-colour `audio` (mono at SR) with the decoder's predicted timbre.

    The reference's excitation and phase are kept, so pitch, timing,
    consonants and the words all survive; only the envelope is replaced.
    """
    audio = np.asarray(audio, dtype=np.float64)
    if len(audio) < N_FFT:
        return audio.astype(np.float32)

    spec = stft(audio)
    mag = np.abs(spec)
    source_env = spectral_envelope(mag, cepstrum_order(SR))
    excitation = mag / (source_env + _EPS)

    predicted = predict_envelope(weights, content_features(audio))
    target_lin = mel_envelope_to_linear(predicted, mag.shape[0], SR)

    # The decoder supplies colour only, so give the predicted envelope the
    # source's own per-frame level back before blending — otherwise the
    # conversion would also flatten the reference's dynamics.
    source_log = np.log(source_env + _EPS)
    target_log = target_lin + source_log.mean(axis=0, keepdims=True)
    blended = source_log + strength * (target_log - source_log)
    new_mag = excitation * np.exp(blended)
    return istft(new_mag * np.exp(1j * np.angle(spec)), len(audio)).astype(np.float32)
