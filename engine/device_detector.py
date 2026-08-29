"""Detects available ONNX Runtime execution providers and best device.

Two distinct notions of "device" live here, and the UI needs both:

* **Inference** runs through ONNX Runtime, so what matters is which
  *execution provider* is available (CoreML / DirectML / CUDA / CPU).
* **Training** runs through PyTorch (see trainer.py), where what matters is
  ``torch.cuda.is_available()`` / ``torch.backends.mps.is_available()``.

They disagree in practice — a Windows box with `onnxruntime-directml` but a
CPU-only torch wheel reports "DirectML" for inference while training still
lands on the CPU. Reporting only the ORT provider is what let the Training
view show "GPU" while a run then crawled along on the CPU, so
:func:`detect_device` returns both, plus a ``training_device`` the renderer
can display verbatim.
"""
from __future__ import annotations

import platform
import sys
from typing import TypedDict


class DeviceInfo(TypedDict):
    ep: str          # best execution provider short name
    provider: str    # full ORT provider string
    providers: list[str]
    platform: str
    python: str
    # Training-side (PyTorch) detection — see module docstring.
    torch_available: bool
    torch_version: str | None
    cuda_available: bool
    mps_available: bool
    gpu_available: bool          # either CUDA or MPS usable for training
    gpu_name: str | None
    training_device: str         # "cuda" | "mps" | "cpu"
    cpu_slowdown_factor: int     # rough CPU-vs-GPU multiplier for the UI warning
    detail: str | None           # why torch detection came out the way it did


# How much slower a CPU training run is than a GPU one. Deliberately a range
# (see CPU_SLOWDOWN_FACTOR usage in the renderer's warning copy) — measured
# against the mode cards' own GPU/CPU estimates in ModeSelector.tsx, which
# put standard at ≤5 min GPU / ≤20 min CPU and professional at ≤90 min /
# ≤6 h, i.e. roughly 4-8x. Rounded out to 5-10x so the warning errs on the
# side of over-warning rather than under-promising.
CPU_SLOWDOWN_FACTOR = 5
CPU_SLOWDOWN_FACTOR_MAX = 10


def _ort_providers() -> list[str]:
    import onnxruntime as ort  # noqa: PLC0415
    return ort.get_available_providers()


class TorchInfo(TypedDict):
    torch_available: bool
    torch_version: str | None
    cuda_available: bool
    mps_available: bool
    gpu_available: bool
    gpu_name: str | None
    training_device: str
    detail: str | None


def detect_training_device() -> TorchInfo:
    """Report what PyTorch can actually train on, without raising.

    Mirrors trainer._pick_device (including its MPS canary allocation) so the
    device the UI advertises is the device the run will really use. Every
    failure mode — torch missing entirely, a driver that reports a GPU it
    can't allocate on — degrades to CPU with a human-readable ``detail``
    rather than propagating an exception into device detection.
    """
    try:
        import torch  # noqa: PLC0415
    except Exception as exc:  # ImportError, but also a broken/partial install
        return TorchInfo(
            torch_available=False, torch_version=None,
            cuda_available=False, mps_available=False,
            gpu_available=False, gpu_name=None, training_device="cpu",
            detail=f"PyTorch is not installed or failed to import: {exc}",
        )

    version = getattr(torch, "__version__", None)

    try:
        cuda = bool(torch.cuda.is_available())
    except Exception:
        cuda = False
    if cuda:
        try:
            name = torch.cuda.get_device_name(0)
        except Exception:
            name = "CUDA device"
        return TorchInfo(
            torch_available=True, torch_version=version,
            cuda_available=True, mps_available=False,
            gpu_available=True, gpu_name=name, training_device="cuda",
            detail=None,
        )

    try:
        mps = bool(torch.backends.mps.is_available())
    except Exception:
        mps = False
    if mps:
        try:
            # Same canary as trainer._pick_device: some environments report
            # MPS as available but fail on the first real allocation.
            torch.zeros(1, device="mps")
        except Exception as exc:
            return TorchInfo(
                torch_available=True, torch_version=version,
                cuda_available=False, mps_available=True,
                gpu_available=False, gpu_name=None, training_device="cpu",
                detail=f"Apple MPS reported available but unusable: {exc}",
            )
        return TorchInfo(
            torch_available=True, torch_version=version,
            cuda_available=False, mps_available=True,
            gpu_available=True, gpu_name="Apple GPU (MPS)", training_device="mps",
            detail=None,
        )

    return TorchInfo(
        torch_available=True, torch_version=version,
        cuda_available=False, mps_available=False,
        gpu_available=False, gpu_name=None, training_device="cpu",
        detail="No CUDA or Apple MPS device is available to PyTorch.",
    )


def detect_device() -> DeviceInfo:
    """Return the best available EP and training device, with platform details."""
    try:
        providers = _ort_providers()
    except Exception:
        # Not just ImportError: a broken or partially-quarantined onnxruntime
        # install raises at import time in other ways too, and device
        # detection must degrade to CPU rather than take the whole call down.
        providers = []

    ep, provider = _pick_best(providers) if providers else ("CPU", "CPUExecutionProvider")
    torch_info = detect_training_device()

    return DeviceInfo(
        ep=ep,
        provider=provider,
        providers=providers,
        platform=sys.platform,
        python=platform.python_version(),
        torch_available=torch_info["torch_available"],
        torch_version=torch_info["torch_version"],
        cuda_available=torch_info["cuda_available"],
        mps_available=torch_info["mps_available"],
        gpu_available=torch_info["gpu_available"],
        gpu_name=torch_info["gpu_name"],
        training_device=torch_info["training_device"],
        cpu_slowdown_factor=CPU_SLOWDOWN_FACTOR,
        detail=torch_info["detail"],
    )


def _pick_best(providers: list[str]) -> tuple[str, str]:
    if sys.platform == "darwin" and "CoreMLExecutionProvider" in providers:
        # Apple Silicon (and Intel Mac) hardware via Core ML
        return "CoreML", "CoreMLExecutionProvider"
    if sys.platform == "win32" and "DmlExecutionProvider" in providers:
        # Windows DirectML covers Nvidia/AMD/Intel integrated GPU
        return "DirectML", "DmlExecutionProvider"
    if "CUDAExecutionProvider" in providers:
        return "CUDA", "CUDAExecutionProvider"
    return "CPU", "CPUExecutionProvider"


def ordered_providers_for_ep(ep_provider: str) -> list[str]:
    """Return a provider list with the chosen EP first, CPU as fallback."""
    if ep_provider == "CPUExecutionProvider":
        return ["CPUExecutionProvider"]
    return [ep_provider, "CPUExecutionProvider"]
