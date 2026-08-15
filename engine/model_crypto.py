"""
AES-256-GCM encryption / decryption for model files.

Layout of an encrypted file:
  nonce[12] | auth_tag[16] | ciphertext[N]  (total = N + 28 bytes)

The encryption key is supplied by the Electron main process (machine-bound).
Decryption without the matching key raises InvalidTag (AES-GCM auth failure),
so a model copied to another machine simply cannot be loaded.
"""
from __future__ import annotations

import os
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM as _AESGCM
    _HAVE_CRYPTO = True
except ImportError:
    _HAVE_CRYPTO = False


def _require_crypto() -> None:
    if not _HAVE_CRYPTO:
        raise ImportError("pip install cryptography  # required for model encryption")


def encrypt_file(src: Path, key_hex: str, dst: Path | None = None) -> Path:
    """
    Encrypt src (ONNX file) → dst (default: src.with_suffix('.enc')).
    key_hex: 64-char hex string (32-byte AES-256 key).
    """
    _require_crypto()
    key  = bytes.fromhex(key_hex)
    if len(key) != 32:
        raise ValueError("Key must be 32 bytes (64 hex chars)")
    dst = dst or src.with_suffix('.enc')
    nonce      = os.urandom(12)
    ciphertext = _AESGCM(key).encrypt(nonce, src.read_bytes(), None)
    # auth_tag is appended by AESGCM.encrypt as the last 16 bytes of ciphertext
    dst.write_bytes(nonce + ciphertext)
    return dst


def decrypt_to_bytes(enc_path: Path, key_hex: str) -> bytes:
    """
    Decrypt enc_path → plaintext ONNX bytes (never written to disk).
    Raises cryptography.exceptions.InvalidTag if key or file is wrong.
    """
    _require_crypto()
    key  = bytes.fromhex(key_hex)
    data = enc_path.read_bytes()
    nonce, ct = data[:12], data[12:]
    return _AESGCM(key).decrypt(nonce, ct, None)


def load_encrypted_session(enc_path: Path, key_hex: str,
                            providers: list[str] | None = None) -> "ort.InferenceSession":
    """
    Decrypt enc_path and load directly into an ORT InferenceSession
    without writing plaintext to disk.
    """
    import onnxruntime as ort  # noqa: PLC0415
    plaintext = decrypt_to_bytes(enc_path, key_hex)
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(plaintext, sess_options=opts,
                                providers=providers or ["CPUExecutionProvider"])
