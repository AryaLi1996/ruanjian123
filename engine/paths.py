"""Filesystem helpers for locating writable scratch space.

The engine bundle is read-only when the app runs from a DMG, an app bundle, or
Program Files, so generated files must never be written next to the source.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


def writable_dir() -> Path:
    """Scratch directory supplied by the Electron main process, or a temp fallback."""
    base = os.environ.get("RUANJIAN_DATA_DIR") or Path(tempfile.gettempdir()) / "ruanjian"
    path = Path(base)
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_model(model_path: Path, build: "callable[[Path], None]") -> Path:
    """Return a usable model path, generating a stub in scratch space if needed.

    `build` receives the destination path and must write the model to it.
    """
    model_path = Path(model_path)
    if model_path.exists():
        return model_path

    try:
        model_path.parent.mkdir(parents=True, exist_ok=True)
        build(model_path)
        return model_path
    except OSError:
        fallback = writable_dir() / model_path.name
        if not fallback.exists():
            build(fallback)
        return fallback
