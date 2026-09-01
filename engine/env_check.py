"""Pre-flight environment self-check for the training pipeline (Ticket T3).

The most common "the app doesn't work" report is not a bug in the training
code at all — it's an environment the engine can't run in: a missing torch
wheel, a machine with no free disk for the exported model, an antivirus that
quarantined part of the bundle. Those all surface today as an opaque failure
minutes into a run (or as the 15s startup timeout in Ticket T1).

This module turns that into an explicit, inspectable checklist that the UI can
render *before* the user presses "start training", with one entry per thing
that can go wrong and a stable ``id`` the renderer maps to localized copy and
repair instructions.

Every individual probe is defensive: a check that itself explodes is reported
as a failed check, never as an exception out of :func:`check_environment`. A
self-check that crashes would be strictly worse than no self-check at all.
"""
from __future__ import annotations

import importlib
import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Literal, TypedDict

Status = Literal["ok", "warn", "fail"]

# Python floor. Matches the engine's own syntax use (PEP 604 unions under
# `from __future__ import annotations`, TypedDict, the walrus-free 3.9+ dict
# merge in main.py) and what scripts/package-engine.sh builds against.
MIN_PYTHON = (3, 9)

# Free space needed under the engine's writable data dir for one training run:
# the checkpointed weights, the exported ONNX model, and the resampled copies
# of the uploaded audio the dataset loader writes out.
MIN_FREE_DISK_GB = 2.0

# Below this a professional run (rank-8, all layers) will thrash or be OOM-
# killed on CPU. It's a warning rather than a hard failure: a standard run
# fits comfortably, and refusing to start on a 4 GB machine would block a
# workflow that does actually complete there.
MIN_RAM_GB = 8.0

# Import name → what the user has to install to get it. Kept in sync with
# engine/requirements.txt; the third element marks packages training cannot
# run without at all versus ones that only disable a feature.
_REQUIRED_PACKAGES: list[tuple[str, str, bool]] = [
    ("numpy",        "numpy",        True),
    ("torch",        "torch",        True),
    ("onnx",         "onnx",         True),
    ("onnxruntime",  "onnxruntime",  True),
    ("soundfile",    "soundfile",    True),
    ("librosa",      "librosa",      True),
    ("soxr",         "soxr",         False),
    ("cryptography", "cryptography", False),
]


class Check(TypedDict):
    id:      str
    status:  Status
    label:   str      # English fallback; the renderer localizes by `id`
    detail:  str
    # Filled in for package checks so the UI can show the exact install line.
    fix:     str | None


class EnvironmentReport(TypedDict):
    passed:   bool          # nothing failed — training may start
    checks:   list[Check]
    device:   dict
    platform: str
    python:   str
    missing:  list[str]     # pip names of missing *required* packages


def _check(id: str, status: Status, label: str, detail: str, fix: str | None = None) -> Check:
    return Check(id=id, status=status, label=label, detail=detail, fix=fix)


def check_python() -> Check:
    version = platform.python_version()
    ok = sys.version_info[:2] >= MIN_PYTHON
    return _check(
        "python",
        "ok" if ok else "fail",
        "Python runtime",
        f"Python {version} ({sys.executable or 'bundled'})",
        None if ok else f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ is required.",
    )


def check_packages() -> tuple[list[Check], list[str]]:
    """One check per dependency, plus the pip names of the missing required ones."""
    checks: list[Check] = []
    missing: list[str] = []
    for module, pip_name, required in _REQUIRED_PACKAGES:
        try:
            mod = importlib.import_module(module)
        except Exception as exc:
            if required:
                missing.append(pip_name)
            checks.append(_check(
                f"package.{module}",
                "fail" if required else "warn",
                f"Python package: {module}",
                f"Not importable: {exc}",
                f"pip install {pip_name}",
            ))
            continue
        version = getattr(mod, "__version__", "unknown")
        checks.append(_check(
            f"package.{module}", "ok",
            f"Python package: {module}", f"{module} {version}",
        ))
    return checks, missing


def check_device() -> tuple[Check, dict]:
    """GPU availability. Never a failure — CPU training works, just slowly."""
    try:
        from device_detector import detect_device  # noqa: PLC0415
        info = dict(detect_device())
    except Exception as exc:
        return _check(
            "device", "warn", "Compute device",
            f"Device detection failed: {exc}. Training will fall back to the CPU.",
        ), {"training_device": "cpu", "gpu_available": False}

    if info.get("gpu_available"):
        return _check(
            "device", "ok", "Compute device",
            f"GPU available: {info.get('gpu_name')} ({info.get('training_device')})",
        ), info
    return _check(
        "device", "warn", "Compute device",
        info.get("detail") or "No GPU detected — training will run on the CPU and take much longer.",
    ), info


def _total_ram_gb() -> float | None:
    """Physical RAM in GB, or None where we can't tell.

    Deliberately avoids psutil: it isn't in requirements.txt, and the engine
    ships as a PyInstaller bundle where an optional import that only exists on
    the developer's machine silently changes behaviour between dev and the
    packaged build.
    """
    try:
        if hasattr(os, "sysconf") and "SC_PAGE_SIZE" in os.sysconf_names and "SC_PHYS_PAGES" in os.sysconf_names:
            return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / (1024 ** 3)
    except Exception:
        pass
    if sys.platform == "darwin":
        try:
            import subprocess  # noqa: PLC0415
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5)
            return int(out.stdout.strip()) / (1024 ** 3)
        except Exception:
            return None
    if sys.platform == "win32":
        status = _win_memory_status()
        return None if status is None else status.ullTotalPhys / (1024 ** 3)
    return None


def _win_memory_status():
    """Windows GlobalMemoryStatusEx result, or None if it can't be read.

    Shared by the total- and available-RAM probes so both read the same
    struct definition.
    """
    try:
        import ctypes  # noqa: PLC0415

        class _MemStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = _MemStatus()
        status.dwLength = ctypes.sizeof(_MemStatus)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):  # type: ignore[attr-defined]
            return None
        return status
    except Exception:
        return None


def available_ram_gb() -> float | None:
    """Currently *available* (not total) physical RAM in GB, or None where we
    can't tell.

    Total RAM says what the machine has; what decides whether a training run
    survives is what is free right now, with a browser and a DAW already
    resident. Same no-psutil rule as :func:`_total_ram_gb` — everything here
    is stdlib, so the packaged bundle behaves exactly like a dev checkout.
    """
    # Linux: MemAvailable is the kernel's own estimate of what a new workload
    # can claim without swapping — strictly better than MemFree, which ignores
    # reclaimable page cache.
    try:
        meminfo = Path("/proc/meminfo")
        if meminfo.exists():
            for line in meminfo.read_text().splitlines():
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / (1024 ** 2)   # kB → GB
    except Exception:
        pass

    if sys.platform == "darwin":
        try:
            import subprocess  # noqa: PLC0415
            out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5)
            page_size = 4096
            free_pages = 0.0
            for line in out.stdout.splitlines():
                if "page size of" in line:
                    page_size = int(line.rstrip(".").split()[-2])
                # Free + inactive + speculative is the conventional "available"
                # proxy on macOS: inactive pages are reclaimed on demand.
                for label in ("Pages free:", "Pages inactive:", "Pages speculative:"):
                    if line.startswith(label):
                        free_pages += int(line.split(":")[1].strip().rstrip("."))
            return free_pages * page_size / (1024 ** 3)
        except Exception:
            return None

    if sys.platform == "win32":
        try:
            status = _win_memory_status()
            return None if status is None else status.ullAvailPhys / (1024 ** 3)
        except Exception:
            return None

    return None


def check_memory() -> Check:
    total = _total_ram_gb()
    if total is None:
        return _check("memory", "warn", "System memory",
                      "Could not determine how much RAM this machine has.")
    if total >= MIN_RAM_GB:
        return _check("memory", "ok", "System memory", f"{total:.1f} GB RAM")
    return _check(
        "memory", "warn", "System memory",
        f"{total:.1f} GB RAM detected; {MIN_RAM_GB:.0f} GB is recommended. "
        "Professional-mode training may run out of memory — use standard mode.",
    )


def check_disk() -> Check:
    try:
        from paths import writable_dir  # noqa: PLC0415
        target = writable_dir()
        target.mkdir(parents=True, exist_ok=True)
        free_gb = shutil.disk_usage(str(target)).free / (1024 ** 3)
    except Exception as exc:
        return _check("disk", "warn", "Disk space",
                      f"Could not check free disk space: {exc}")
    if free_gb >= MIN_FREE_DISK_GB:
        return _check("disk", "ok", "Disk space", f"{free_gb:.1f} GB free")
    return _check(
        "disk", "fail", "Disk space",
        f"Only {free_gb:.1f} GB free; at least {MIN_FREE_DISK_GB:.0f} GB is needed "
        "for training checkpoints and the exported model.",
        "Free up disk space and run the check again.",
    )


def check_writable() -> Check:
    """The packaged engine directory is read-only, so an unwritable data dir
    breaks training at the very last step (model export) after burning the
    entire run. Prove it's writable up front instead."""
    try:
        from paths import writable_dir  # noqa: PLC0415
        target = writable_dir()
        target.mkdir(parents=True, exist_ok=True)
        probe = target / ".env_check_write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return _check("writable", "ok", "Data directory", f"Writable: {target}")
    except Exception as exc:
        return _check(
            "writable", "fail", "Data directory",
            f"The engine's data directory is not writable: {exc}",
            "Check folder permissions, or whether antivirus software is blocking the app.",
        )


def check_environment(_args=None) -> EnvironmentReport:
    """Run every probe and summarize. Never raises."""
    checks: list[Check] = [check_python()]

    package_checks, missing = check_packages()
    checks.extend(package_checks)

    device_check, device_info = check_device()
    checks.append(device_check)
    checks.append(check_memory())
    checks.append(check_disk())
    checks.append(check_writable())

    return EnvironmentReport(
        passed=all(c["status"] != "fail" for c in checks),
        checks=checks,
        device=device_info,
        platform=f"{platform.system()} {platform.release()} ({platform.machine()})",
        python=platform.python_version(),
        missing=missing,
    )
