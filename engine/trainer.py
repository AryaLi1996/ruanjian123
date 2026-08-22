"""
Training utilities for Micro-VITS singing voice model fine-tuning.

Provides:
  MicroVITSModel          – PyTorch model matching the ONNX architecture
  LoRALinear              – standard LoRA adapter for nn.Linear
  LoRAPlusLinear          – LoRA+ (higher LR for B matrix, faster convergence)
  apply_lora()            – inject adapters into a model
  preprocess_vocals()     – slice + loudness-normalise raw vocal audio
  VocalDataset            – PyTorch Dataset over preprocessed chunks
  build_optimizer()       – Adam with LoRA+ param groups when needed
  train()                 – training loop with JSON-line progress reporting
  export_to_onnx()        – merge LoRA, export to ONNX, verify with ORT
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Literal, TypedDict

import numpy as np
import soundfile as sf
import torch
import torch.nn as nn
from torch.utils.checkpoint import checkpoint as grad_ckpt
from torch.utils.data import DataLoader, Dataset

SYNTH_SR      = 22_050
SYNTH_HOP     = 256
CHUNK_FRAMES  = 256          # frames per training sample → 256 × 256 = 65536 ≈ 3 s
TARGET_RMS_DB = -20.0        # loudness normalisation target

# Ticket 48 §2: minimum training material per mode, and the SNR floor below
# which uploaded vocals are noisy/reverberant enough that the model is
# likely to learn and reproduce the noise instead of the singer's timbre.
MIN_DURATION_SEC: dict[str, float] = {"standard": 300.0, "professional": 900.0}
MIN_SNR_DB = 15.0


# ── Model ─────────────────────────────────────────────────────────────────────

class MicroVITSModel(nn.Module):
    """
    PyTorch twin of the ONNX Micro-VITS synthesiser built in synthesizer.py.

    Forward pass:
      h0 = layer1(audio_frames)                [B, T, 256]
      h1 = h0 + phoneme_cond × ph_scale        [B, T, 256]
      h2 = layer2(h1)                          [B, T, 256]
      return h2.flatten(start_dim=1)           [B, T*256]

    Gradient checkpointing (professional mode) recomputes h0/h2 during the
    backward pass instead of storing them, reducing activation-memory by ~50%.
    """
    HOP = SYNTH_HOP

    def __init__(self, gradient_checkpointing: bool = False) -> None:
        super().__init__()
        H = self.HOP
        self.layer1    = nn.Linear(H, H)
        self.layer2    = nn.Linear(H, H)
        self.ph_scale  = nn.Parameter(torch.full((1, 1, H), 0.05))
        self._gc       = gradient_checkpointing
        self._init_near_identity()

    def _init_near_identity(self) -> None:
        """Match stub ONNX initialisation (near-identity + tiny noise)."""
        rng = np.random.default_rng(0)
        with torch.no_grad():
            for layer in (self.layer1, self.layer2):
                w = (torch.eye(self.HOP) * 0.98
                     + torch.from_numpy(rng.standard_normal((self.HOP, self.HOP)).astype(np.float32)) * 0.01)
                layer.weight.data.copy_(w)
                layer.bias.data.zero_()

    def forward(self, audio_frames: torch.Tensor, phoneme_cond: torch.Tensor) -> torch.Tensor:
        if self._gc:
            h0 = grad_ckpt(self.layer1, audio_frames, use_reentrant=False)
        else:
            h0 = self.layer1(audio_frames)

        h1 = h0 + phoneme_cond * self.ph_scale

        if self._gc:
            h2 = grad_ckpt(self.layer2, h1, use_reentrant=False)
        else:
            h2 = self.layer2(h1)

        return h2.flatten(start_dim=1)  # [B, T*256]


# ── LoRA adapters ─────────────────────────────────────────────────────────────

class LoRALinear(nn.Module):
    """LoRA adapter that wraps an existing nn.Linear (which is frozen)."""

    def __init__(self, linear: nn.Linear, rank: int, alpha: float) -> None:
        super().__init__()
        in_f, out_f = linear.in_features, linear.out_features
        self.original = linear
        self.lora_A   = nn.Linear(in_f, rank, bias=False)
        self.lora_B   = nn.Linear(rank, out_f, bias=False)
        self.scale    = alpha / rank
        nn.init.normal_(self.lora_A.weight, std=0.01)
        nn.init.zeros_(self.lora_B.weight)
        for p in self.original.parameters():
            p.requires_grad_(False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.original(x) + self.scale * self.lora_B(self.lora_A(x))


class LoRAPlusLinear(LoRALinear):
    """
    LoRA+ variant – same graph as LoRALinear.
    The higher learning rate for lora_B is handled by the optimizer param groups
    in build_optimizer(); no architectural difference is needed here.
    """


def apply_lora(
    model: MicroVITSModel,
    mode: Literal["standard", "professional"],
    rank: int | None = None,
    alpha: float | None = None,
) -> MicroVITSModel:
    """
    Inject LoRA adapters in-place and return the modified model.

    standard     : rank=4  – layer1 only (timbre encoder), ph_scale frozen
    professional : rank=8  – layer1 + layer2 (LoRA+), ph_scale trainable
    """
    r   = rank  or (4  if mode == "standard" else 8)
    a   = alpha or (16 if mode == "standard" else 32)
    cls = LoRALinear if mode == "standard" else LoRAPlusLinear

    model.layer1 = cls(model.layer1, r, a)
    if mode == "professional":
        model.layer2 = cls(model.layer2, r, a)
    else:
        # Standard mode is LoRA-only on layer1 (see docstring: "layer1 only").
        # LoRALinear freezes the *original* weights it wraps in its own
        # __init__, but layer2 here is never wrapped at all — it's left as a
        # plain nn.Linear, which defaults requires_grad=True. Without this,
        # "standard" mode silently full-fine-tunes all 65,792 of layer2's
        # parameters on top of layer1's ~2K LoRA params — nearly 8x MORE
        # trainable parameters than "professional" mode (which LoRA-wraps
        # both layers), exactly backwards from standard being the lighter,
        # faster tier. Confirmed via model.parameters() inspection before
        # this fix: standard=67,840 trainable vs professional=8,448.
        for p in model.layer2.parameters():
            p.requires_grad_(False)

    model.ph_scale.requires_grad_(mode == "professional")
    return model


# ── Data preprocessing ────────────────────────────────────────────────────────

def _rms_normalise(audio: np.ndarray, target_db: float = TARGET_RMS_DB) -> np.ndarray:
    rms = float(np.sqrt(np.mean(audio ** 2))) + 1e-8
    return (audio * (10 ** (target_db / 20.0) / rms)).astype(np.float32)


def _linear_resample(audio: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return audio
    n_out = int(len(audio) * sr_out / sr_in)
    return np.interp(np.linspace(0, len(audio) - 1, n_out),
                     np.arange(len(audio)), audio).astype(np.float32)


def preprocess_vocals(
    input_dir:     Path,
    output_dir:    Path,
    sr:            int = SYNTH_SR,
    chunk_samples: int = CHUNK_FRAMES * SYNTH_HOP,
) -> int:
    """
    Read all audio files in input_dir, normalise loudness to TARGET_RMS_DB,
    slice into fixed-length chunks, and save to output_dir as 16-bit WAV.
    Returns the total number of chunks written.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    exts  = {".wav", ".flac", ".ogg", ".mp3"}
    files = [f for f in sorted(input_dir.iterdir()) if f.suffix.lower() in exts]

    chunk_idx = 0
    for path in files:
        try:
            audio, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
        except Exception:
            continue
        audio = audio.mean(axis=1)                        # mono
        audio = _linear_resample(audio, file_sr, sr)
        audio = _rms_normalise(audio)
        for start in range(0, len(audio) - chunk_samples + 1, chunk_samples):
            sf.write(str(output_dir / f"chunk_{chunk_idx:06d}.wav"),
                     audio[start: start + chunk_samples], sr, subtype="PCM_16")
            chunk_idx += 1

    return chunk_idx


def estimate_snr_db(audio: np.ndarray, frame_size: int = 1024) -> float:
    """
    Coarse SNR estimate from frame-RMS statistics: treats the quietest 10%
    of frames as the noise floor and the median frame as signal+noise — a
    standard proxy for source material that has no separate noise
    reference (which training uploads never provide).
    """
    audio = np.asarray(audio, dtype=np.float32)
    n = (len(audio) // frame_size) * frame_size
    if n < frame_size:
        return 0.0
    frames    = audio[:n].reshape(-1, frame_size)
    frame_rms = np.sqrt(np.mean(frames ** 2, axis=1)) + 1e-10
    noise_rms  = float(np.percentile(frame_rms, 10))
    signal_rms = float(np.percentile(frame_rms, 50))
    return float(20.0 * np.log10((signal_rms + 1e-10) / (noise_rms + 1e-10)))


class DataQualityReport(TypedDict):
    n_files:          int
    duration_sec:     float
    min_required_sec: float
    duration_ok:      bool
    snr_db:           float | None
    snr_ok:           bool
    warnings:         list[str]
    passed:           bool


def validate_training_data(
    input_dir: Path, mode: Literal["standard", "professional"],
) -> DataQualityReport:
    """
    Check uploaded vocal material against the minimum duration/cleanliness
    bar for `mode` (Ticket 48 §2) before training spends time on it.

    Duration is read from file metadata only (sf.info — no full decode), so
    this stays cheap even for a folder of long files; SNR needs actual
    samples, so it's estimated from up to 3 representative files. When
    `input_dir` has no readable audio files at all, this reports
    passed=True with n_files=0 — that's the synthetic-dummy-data code path
    (see VocalDataset), not a data-quality failure to warn the user about.
    """
    import soundfile as sf  # noqa: PLC0415

    exts  = {".wav", ".flac", ".ogg", ".mp3"}
    files = ([f for f in sorted(input_dir.iterdir())
              if f.is_file() and f.suffix.lower() in exts]
             if input_dir.exists() else [])

    warnings: list[str] = []
    min_required = MIN_DURATION_SEC[mode]

    total_sec = 0.0
    for f in files:
        try:
            info = sf.info(str(f))
            total_sec += info.frames / info.samplerate
        except Exception:
            warnings.append(f"Could not read '{f.name}' — file skipped.")

    duration_ok = total_sec >= min_required

    snr_db: float | None = None
    if files:
        samples: list[np.ndarray] = []
        for f in files[:3]:
            try:
                audio, _sr = sf.read(str(f), dtype="float32", always_2d=True)
                samples.append(audio.mean(axis=1))
            except Exception:
                continue
        if samples:
            snr_db = float(np.mean([estimate_snr_db(s) for s in samples]))

    snr_ok = snr_db is None or snr_db >= MIN_SNR_DB

    if files and not duration_ok:
        warnings.append(
            f"Training material is {total_sec / 60:.1f} min — {mode} mode "
            f"recommends at least {min_required / 60:.0f} min for reliable "
            "timbre quality. Model quality may be low due to insufficient data.")
    if snr_db is not None and not snr_ok:
        warnings.append(
            f"Training material's estimated SNR ({snr_db:.1f} dB) is low — "
            "background noise or reverb in the source recordings may be "
            "learned and reproduced by the model. Consider re-recording or "
            "denoising the source audio, then retraining.")

    return DataQualityReport(
        n_files=len(files),
        duration_sec=round(total_sec, 1),
        min_required_sec=min_required,
        duration_ok=duration_ok,
        snr_db=round(snr_db, 2) if snr_db is not None else None,
        snr_ok=snr_ok,
        warnings=warnings,
        passed=bool(duration_ok and snr_ok) if files else True,
    )


class VocalDataset(Dataset):
    """
    Loads preprocessed vocal chunks from output_dir.
    Falls back to synthetic sine-wave data when no real chunks are found —
    useful for CI acceptance tests without real recordings.
    """

    _FORMANT_COND: np.ndarray | None = None   # cached per-class

    def __init__(self, data_dir: Path) -> None:
        self.files = sorted(data_dir.glob("chunk_*.wav"))
        self._dummy = len(self.files) == 0

    def __len__(self) -> int:
        # ~5 min of 22050 Hz audio at CHUNK_FRAMES*SYNTH_HOP samples per chunk ≈ 101 chunks
        return 101 if self._dummy else len(self.files)

    def __getitem__(self, idx: int):
        if self._dummy:
            rng = np.random.default_rng(idx)
            f0  = float(rng.choice([261.6, 293.7, 329.6, 349.2, 392.0, 440.0]))
            t   = np.arange(CHUNK_FRAMES * SYNTH_HOP, dtype=np.float32) / SYNTH_SR
            sig = (np.sin(2.0 * np.pi * f0 * t) * 0.5).astype(np.float32)
        else:
            sig, _ = sf.read(str(self.files[idx]), dtype="float32")

        frames = sig[: CHUNK_FRAMES * SYNTH_HOP].reshape(CHUNK_FRAMES, SYNTH_HOP)
        cond   = self._get_formant_cond()
        return torch.from_numpy(frames.copy()), torch.from_numpy(cond.copy())

    @classmethod
    def _get_formant_cond(cls) -> np.ndarray:
        """Stationary "a" vowel formant conditioning [CHUNK_FRAMES, SYNTH_HOP]."""
        if cls._FORMANT_COND is None:
            t = np.arange(SYNTH_HOP, dtype=np.float32) / SYNTH_SR
            row = (0.50 * np.sin(2 * np.pi * 800  * t)
                   + 0.30 * np.sin(2 * np.pi * 1200 * t)
                   + 0.20 * np.sin(2 * np.pi * 2500 * t)) * 0.10
            cls._FORMANT_COND = np.tile(row[None, :], (CHUNK_FRAMES, 1)).astype(np.float32)
        return cls._FORMANT_COND


# ── Optimizer ─────────────────────────────────────────────────────────────────

def build_optimizer(
    model:         MicroVITSModel,
    lr:            float,
    mode:          Literal["standard", "professional"],
    lora_plus_eta: float = 16.0,
    fused:         bool = False,
) -> torch.optim.Optimizer:
    """
    Standard mode  : uniform lr for all trainable params.
    Professional   : LoRA+ — lora_B params get lr × lora_plus_eta.

    fused=True uses PyTorch's fused CUDA Adam kernel (single kernel launch
    for the whole param-group update instead of one per tensor) — only
    valid when every param is a CUDA tensor, so callers must gate it on
    device == "cuda".
    """
    if mode != "professional":
        return torch.optim.Adam(
            [p for p in model.parameters() if p.requires_grad], lr=lr, fused=fused)

    lora_a, lora_b, other = [], [], []
    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        if   "lora_A" in name: lora_a.append(param)
        elif "lora_B" in name: lora_b.append(param)
        else:                  other.append(param)

    return torch.optim.Adam([
        {"params": lora_a, "lr": lr},
        {"params": lora_b, "lr": lr * lora_plus_eta},
        {"params": other,  "lr": lr},
    ], fused=fused)


# ── ONNX export ───────────────────────────────────────────────────────────────

def _merge_lora(model: MicroVITSModel) -> MicroVITSModel:
    """Return a clean MicroVITSModel with LoRA deltas merged into base weights."""
    clean = MicroVITSModel()

    def _resolved(attr: str) -> nn.Linear:
        layer = getattr(model, attr)
        if not isinstance(layer, LoRALinear):
            lin = nn.Linear(layer.in_features, layer.out_features)
            lin.weight.data = layer.weight.data.clone()
            lin.bias.data   = layer.bias.data.clone()
            return lin
        with torch.no_grad():
            delta = layer.scale * (layer.lora_B.weight @ layer.lora_A.weight)
            lin   = nn.Linear(layer.original.in_features, layer.original.out_features)
            lin.weight.data = layer.original.weight.data + delta
            lin.bias.data   = (layer.original.bias.data.clone()
                               if layer.original.bias is not None
                               else torch.zeros(layer.original.out_features))
        return lin

    clean.layer1   = _resolved("layer1")
    clean.layer2   = _resolved("layer2")
    clean.ph_scale = nn.Parameter(model.ph_scale.data.clone())
    return clean


def export_to_onnx(model: MicroVITSModel, output_path: Path) -> int:
    """
    Build the ONNX graph from trained weights using the onnx library directly.
    Avoids torch.onnx.export (which requires onnxscript in PyTorch ≥ 2.1).
    The graph is identical to the stub model in synthesizer.py.
    Returns file size in bytes.
    """
    import onnx as _onnx
    from onnx import TensorProto, helper, numpy_helper

    clean = _merge_lora(model)
    clean.eval()
    clean = clean.cpu()   # numpy conversion requires host memory (MPS/CUDA tensors can't convert)
    hop = SYNTH_HOP

    # PyTorch Linear stores weight as [out, in]; ONNX MatMul needs [in, out]
    W1 = clean.layer1.weight.detach().cpu().numpy().T.astype(np.float32)
    b1 = clean.layer1.bias.detach().cpu().numpy().astype(np.float32)
    W2 = clean.layer2.weight.detach().cpu().numpy().T.astype(np.float32)
    b2 = clean.layer2.bias.detach().cpu().numpy().astype(np.float32)
    ph = clean.ph_scale.detach().cpu().numpy().astype(np.float32)  # [1, 1, hop]

    af_vi  = helper.make_tensor_value_info("audio_frames", TensorProto.FLOAT, [None, None, hop])
    pc_vi  = helper.make_tensor_value_info("phoneme_cond",  TensorProto.FLOAT, [None, None, hop])
    out_vi = helper.make_tensor_value_info("audio",         TensorProto.FLOAT, [None, None])

    nodes = [
        helper.make_node("MatMul",  ["audio_frames", "W1"],       ["h0"]),
        helper.make_node("Add",     ["h0", "b1"],                 ["h1"]),
        helper.make_node("Mul",     ["phoneme_cond", "ph_scale"], ["pc_s"]),
        helper.make_node("Add",     ["h1", "pc_s"],               ["h2"]),
        helper.make_node("MatMul",  ["h2", "W2"],                 ["h3"]),
        helper.make_node("Add",     ["h3", "b2"],                 ["frames_out"]),
        helper.make_node("Flatten", ["frames_out"],               ["audio"], axis=1),
    ]
    inits = [
        numpy_helper.from_array(W1, "W1"),
        numpy_helper.from_array(b1, "b1"),
        numpy_helper.from_array(W2, "W2"),
        numpy_helper.from_array(b2, "b2"),
        numpy_helper.from_array(ph, "ph_scale"),
    ]
    graph = helper.make_graph(nodes, "micro_vits", [af_vi, pc_vi], [out_vi],
                               initializer=inits)
    proto = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)],
                               ir_version=8)
    _onnx.checker.check_model(proto)
    raw = proto.SerializeToString()
    output_path.write_bytes(raw)

    # Verify the exported model runs correctly under ORT
    import onnxruntime as ort
    sess = ort.InferenceSession(str(output_path), providers=["CPUExecutionProvider"])
    dummy = np.random.randn(1, 4, hop).astype(np.float32)
    sess.run(["audio"], {"audio_frames": dummy, "phoneme_cond": dummy})

    return len(raw)


# ── Training loop ─────────────────────────────────────────────────────────────

def _pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        try:
            # Some environments (notably GitHub Actions' macOS runners —
            # VMs without real GPU passthrough) report MPS as available via
            # this check but can't actually allocate on it, failing with
            # "MPS backend out of memory" on the very first real tensor op.
            # A tiny canary allocation catches that upfront instead of
            # failing partway through a training run; also protects a real
            # user's machine if MPS is simply in a bad state for other
            # reasons (e.g. another app pinning GPU memory) — either way,
            # CPU is always a safe fallback for a small model like this.
            torch.zeros(1, device="mps")
            return "mps"
        except RuntimeError:
            pass
    return "cpu"


def _si_snr(ref: np.ndarray, est: np.ndarray) -> float:
    """Scale-invariant SNR — same proxy metric _test_suite.py uses for
    synthesis quality, reused here (not imported, since _test_suite.py is a
    test-only module) to score how faithfully the exported model
    reconstructs its own training material."""
    ref = ref - ref.mean(); est = est - est.mean()
    alpha  = float(np.dot(est, ref) / (np.dot(ref, ref) + 1e-8))
    target = alpha * ref
    error  = est - target
    return float(10.0 * np.log10(np.sum(target ** 2) / (np.sum(error ** 2) + 1e-8)))


def _configure_backend(device: str) -> None:
    """One-time perf knobs. No-ops on backends that don't support them."""
    if device == "cuda":
        # Let cuDNN pick the fastest conv/matmul algorithm for our fixed
        # input shapes (safe here — every batch is the same shape), and
        # allow TF32 matmuls on Ampere+ for a free throughput bump.
        torch.backends.cudnn.benchmark = True
        torch.set_float32_matmul_precision("high")


def train(
    data_dir:      Path,
    output_path:   Path,
    mode:          Literal["standard", "professional"] = "standard",
    epochs:        int   = 50,
    batch_size:    int   = 32,
    lr:            float = 1e-4,
    lora_plus_eta: float = 16.0,
    device:        str | None = None,
    progress_path: Path | None = None,
) -> dict:
    """
    Full training entry point.

    Emits one JSON line per epoch to stdout (for UI streaming) and optionally
    writes the latest progress dict to progress_path for polling.
    Returns the final stats dict.
    """
    device = device or _pick_device()
    gc     = (mode == "professional")   # gradient checkpointing in pro mode
    _configure_backend(device)

    # Ticket 48 §2: check the raw upload against the minimum duration/SNR
    # bar for this mode before spending training time on it. This never
    # blocks training (a short/noisy upload still trains — it just may
    # produce a low-quality model) but the warnings/quality_score below
    # let the caller tell the user why.
    data_quality = validate_training_data(data_dir, mode)

    model = MicroVITSModel(gradient_checkpointing=gc)
    model = apply_lora(model, mode)
    model.to(device)

    opt = build_optimizer(model, lr, mode, lora_plus_eta, fused=(device == "cuda"))

    # Preprocess raw data if needed; fall back to synthetic dataset if empty
    proc_dir = data_dir / "_processed"
    if not proc_dir.exists() or not any(proc_dir.glob("chunk_*.wav")):
        n = preprocess_vocals(data_dir, proc_dir)
        if n == 0:
            proc_dir = data_dir   # VocalDataset will use dummy mode

    dataset = VocalDataset(proc_dir)
    # Worker processes only pay off when __getitem__ does real disk I/O
    # (the synthetic/dummy fallback is pure in-memory sine-wave math, where
    # process spawn/IPC overhead would make things slower, not faster).
    n_workers = min(4, os.cpu_count() or 1) if not dataset._dummy else 0
    loader = DataLoader(
        dataset, batch_size=batch_size, shuffle=True, drop_last=True,
        num_workers=n_workers,
        pin_memory=(device == "cuda"),
        persistent_workers=n_workers > 0,
    )
    loss_fn = nn.MSELoss()

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total     = sum(p.numel() for p in model.parameters())

    # AMP: real speedup on CUDA tensor cores; harmless no-op elsewhere.
    # GradScaler(enabled=False)/autocast(enabled=False) fall straight
    # through to plain fp32 ops, so this one code path is safe on CPU/MPS.
    amp_enabled = (device == "cuda")
    scaler      = torch.cuda.amp.GradScaler(enabled=amp_enabled)
    trainable_params = [p for p in model.parameters() if p.requires_grad]

    # Cosine LR decay improves final convergence over a flat LR for the
    # short fine-tuning runs this trainer targets (LoRA fine-tuning
    # benefits from annealing toward the end of training).
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(epochs, 1))

    t0        = time.perf_counter()
    best_loss = float("inf")

    for epoch in range(1, epochs + 1):
        model.train()
        epoch_loss_t = torch.zeros((), device=device)
        n_batches    = 0

        for frames, cond in loader:
            frames = frames.to(device, non_blocking=True)
            cond   = cond.to(device, non_blocking=True)
            opt.zero_grad(set_to_none=True)
            with torch.autocast(device_type="cuda", enabled=amp_enabled):
                pred   = model(frames, cond)
                target = frames.flatten(start_dim=1)
                loss   = loss_fn(pred, target)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(trainable_params, max_norm=1.0)
            scaler.step(opt)
            scaler.update()
            # Accumulate on-device and defer the CPU sync (.item()) to once
            # per epoch instead of once per batch — on CUDA/MPS every
            # .item() call forces a device sync that stalls the pipeline.
            epoch_loss_t += loss.detach()
            n_batches    += 1

        scheduler.step()
        avg_loss  = (epoch_loss_t / max(n_batches, 1)).item()
        best_loss = min(best_loss, avg_loss)
        elapsed   = time.perf_counter() - t0

        prog = {
            "epoch":        epoch,
            "total_epochs": epochs,
            "loss":         round(avg_loss, 6),
            "best_loss":    round(best_loss, 6),
            "elapsed_sec":  round(elapsed, 1),
            "percent":      round(epoch / epochs * 100, 1),
            "status":       "training",
            "device":       device,
        }
        print(json.dumps(prog), flush=True)
        if progress_path:
            progress_path.write_text(json.dumps(prog))

    # Export
    output_path.parent.mkdir(parents=True, exist_ok=True)
    model_bytes = export_to_onnx(model, output_path)
    elapsed     = time.perf_counter() - t0

    # Ticket 48 §5: score how faithfully the trained model reproduces its
    # own training material (SI-SNR of reconstruction vs. the real target)
    # as a proxy for timbre fidelity, and surface a plain warning when it's
    # low so a bad model doesn't look identical to a good one in the UI.
    model.eval()
    with torch.no_grad():
        sample_frames, sample_cond = dataset[0]
        recon = model(sample_frames.unsqueeze(0).to(device), sample_cond.unsqueeze(0).to(device))
        ref = sample_frames.flatten().detach().cpu().numpy().astype(np.float64)
        est = recon[0].detach().cpu().numpy().astype(np.float64)
    quality_snr_db = _si_snr(ref, est)
    quality_score  = float(np.clip(quality_snr_db / 30.0, 0.0, 1.0))  # 30 dB ≈ excellent

    quality_warning: str | None = None
    if quality_score < 0.4 or not data_quality["passed"]:
        quality_warning = (
            "Model quality may be low due to insufficient or noisy training "
            "data. Consider retraining with more (or cleaner) vocal recordings."
        )

    final = {
        "status":           "done",
        "mode":             mode,
        "epochs":           epochs,
        "best_loss":        round(best_loss, 6),
        "trainable_params": trainable,
        "total_params":     total,
        "elapsed_sec":      round(elapsed, 1),
        "output_path":      str(output_path),
        "model_bytes":      model_bytes,
        "device":           device,
        "quality_score":    round(quality_score, 4),
        "quality_snr_db":   round(quality_snr_db, 2),
        "quality_warning":  quality_warning,
        "data_quality":     dict(data_quality),
        # acceptance: standard ≤ 20 min CPU, professional ≤ 90 min CPU
        "passed":           elapsed <= (1200 if mode == "standard" else 5400),
    }
    print(json.dumps(final), flush=True)
    if progress_path:
        progress_path.write_text(json.dumps(final))

    # Release accelerator memory before exit so the parent app isn't left under pressure.
    del model
    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()

    return final
