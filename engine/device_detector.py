"""Detects available ONNX Runtime execution providers and best device."""
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


def _ort_providers() -> list[str]:
    import onnxruntime as ort  # noqa: PLC0415
    return ort.get_available_providers()


def detect_device() -> DeviceInfo:
    """Return the best available EP, with platform details."""
    try:
        providers = _ort_providers()
    except ImportError:
        return DeviceInfo(
            ep="CPU",
            provider="CPUExecutionProvider",
            providers=[],
            platform=sys.platform,
            python=platform.python_version(),
        )

    # Priority: platform-specific GPU EP → CUDA → CPU
    ep, provider = _pick_best(providers)

    return DeviceInfo(
        ep=ep,
        provider=provider,
        providers=providers,
        platform=sys.platform,
        python=platform.python_version(),
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
