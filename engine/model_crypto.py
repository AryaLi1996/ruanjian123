"""
AES-256-GCM encryption / decryption for model files.

Layout of an encrypted file:
  nonce[12] | auth_tag[16] | ciphertext[N]  (total = N + 28 bytes)

This MUST match src/main/model-crypto.ts byte-for-byte — both sides are
handed the same machine-bound key (see Electron main's getModelKey /
IPC-exposed key hex) so either can encrypt/decrypt a model the other
produced. Node's `crypto` GCM API returns the tag separately from the
ciphertext (via cipher.getAuthTag()), so the TS side naturally writes
tag-before-ciphertext; Python's `cryptography` AESGCM.encrypt() returns
tag-appended-to-ciphertext instead, so this module explicitly re-slices it
on the way in and out to land on the same on-disk layout as the TS side.
Do not "simplify" this by writing AESGCM's output as-is — that silently
reintroduces the mismatch (encrypt on one side, decrypt on the other, get
InvalidTag every time) with nothing in either language's own tests to catch
it, since neither test suite decrypts what the other side encrypted.

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

_NONCE_LEN = 12
_TAG_LEN   = 16


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
    nonce = os.urandom(_NONCE_LEN)
    # AESGCM.encrypt() returns ciphertext with the 16-byte tag appended at
    # the end; re-slice so the file lands as nonce|tag|ciphertext, matching
    # the TS side (see module docstring).
    ct_and_tag = _AESGCM(key).encrypt(nonce, src.read_bytes(), None)
    ciphertext, tag = ct_and_tag[:-_TAG_LEN], ct_and_tag[-_TAG_LEN:]
    dst.write_bytes(nonce + tag + ciphertext)
    return dst


def decrypt_to_bytes(enc_path: Path, key_hex: str) -> bytes:
    """
    Decrypt enc_path → plaintext ONNX bytes (never written to disk).
    Raises cryptography.exceptions.InvalidTag if key or file is wrong.
    """
    _require_crypto()
    key  = bytes.fromhex(key_hex)
    data = enc_path.read_bytes()
    nonce      = data[:_NONCE_LEN]
    tag        = data[_NONCE_LEN:_NONCE_LEN + _TAG_LEN]
    ciphertext = data[_NONCE_LEN + _TAG_LEN:]
    # AESGCM.decrypt() wants the tag appended back on, the reverse of the
    # re-slice encrypt_file() did above.
    return _AESGCM(key).decrypt(nonce, ciphertext + tag, None)


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
