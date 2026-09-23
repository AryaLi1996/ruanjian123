"""
Filling the mark's pixels with a learned model.

Kept apart from the HTTP layer so it can be exercised without a server, and so
the one thing that is easy to get wrong here — fitting a patch that is neither
square nor 512 wide into a model that insists on both — lives in one place.

The model is LaMa, exported to ONNX. It is loaded once: the file is 208 MB and
the session is thread-safe, so a process holds one and answers every request
from it.
"""
from __future__ import annotations

import os
import threading

import cv2
import numpy as np
import onnxruntime as ort

# What the exported graph accepts. A dynamic export would avoid the padding
# below and the wasted compute that comes with it, at the cost of having to
# export it ourselves rather than taking one off the shelf.
MODEL_SIDE = 512

# Patches arrive already cropped to the mark; this is a guard against a client
# asking the service to inpaint something the size of a whole frame.
MAX_PATCH_SIDE = 1024

# The patch is scaled so its longer side fills the model's input. LaMa is
# trained on far larger pictures than a watermark's box and does visibly worse
# when handed one near its own scale: 7.81 levels of error at 1:1 against 6.65
# at three times that, and end to end a patch scaled to 384 rather than 512
# left 0.383 of the mark's shape behind where filling the input leaves none.
# There is no reason to hand the model less than it will process anyway.

_lock = threading.Lock()
_session: ort.InferenceSession | None = None


def model_path() -> str:
    """Where the ONNX file is. Not vendored; the deployment says."""
    path = os.environ.get('LAMA_ONNX')
    if not path:
        raise RuntimeError('LAMA_ONNX is not set: nothing to load')
    return path


def session() -> ort.InferenceSession:
    """The one session this process holds, created on first use."""
    global _session
    if _session is None:
        with _lock:
            if _session is None:
                options = ort.SessionOptions()
                options.intra_op_num_threads = int(os.environ.get('LAMA_THREADS', '0')) or os.cpu_count() or 4
                _session = ort.InferenceSession(
                    model_path(), options,
                    providers=ort.get_available_providers(),
                )
    return _session


def _to_model_frame(patch: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    """
    Scale a patch up to something the model works well at, then pad it to the
    square it insists on. Returns the tensors and the size to crop back to.
    """
    height, width = mask.shape
    scale = MODEL_SIDE / max(width, height)
    working = (min(MODEL_SIDE, max(1, int(round(width * scale)))),
               min(MODEL_SIDE, max(1, int(round(height * scale)))))

    image = cv2.resize(patch, working, interpolation=cv2.INTER_CUBIC)
    grown = (cv2.resize(mask * 255, working, interpolation=cv2.INTER_LINEAR) > 64).astype(np.uint8)

    pad_x, pad_y = MODEL_SIDE - working[0], MODEL_SIDE - working[1]
    # Reflect the picture into the padding and leave the mask empty there: the
    # model then has plausible context to reason from and nothing to repaint.
    image = cv2.copyMakeBorder(image, 0, pad_y, 0, pad_x, cv2.BORDER_REFLECT)
    grown = cv2.copyMakeBorder(grown, 0, pad_y, 0, pad_x, cv2.BORDER_CONSTANT, value=0)
    return image, grown, working


def fill(patches: list[np.ndarray], mask: np.ndarray) -> list[np.ndarray]:
    """
    Repaint the masked pixels of every patch.

    `patches` are RGB uint8 and all the same size; `mask` is uint8, 1 where the
    mark is, shared by all of them because the mark does not move. Returns
    patches of the size they came in at.
    """
    if not patches:
        return []
    height, width = mask.shape
    if max(height, width) > MAX_PATCH_SIDE:
        raise ValueError(f'patch is {width}x{height}; the limit is {MAX_PATCH_SIDE}')
    for patch in patches:
        if patch.shape[:2] != mask.shape:
            raise ValueError('every patch must be the size of the mask')

    images, grown, working = [], None, None
    for patch in patches:
        image, grown, working = _to_model_frame(patch, mask)
        images.append(image)

    batch = np.stack(images).transpose(0, 3, 1, 2).astype(np.float32) / 255.0
    masks = np.repeat(grown[None, None].astype(np.float32), len(images), axis=0)

    runner = session()
    names = [i.name for i in runner.get_inputs()]
    out = runner.run(None, {names[0]: batch, names[1]: masks})[0]

    filled = []
    for single in out:
        picture = single.transpose(1, 2, 0)
        if picture.max() <= 1.01:
            picture = picture * 255.0
        picture = np.clip(picture[:working[1], :working[0]], 0, 255).astype(np.uint8)
        filled.append(cv2.resize(picture, (width, height), interpolation=cv2.INTER_AREA))
    return filled
