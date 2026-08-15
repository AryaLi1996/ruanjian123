#!/usr/bin/env python3
"""Acceptance tests for Ticket 12: watermark round-trip + model encryption."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from pathlib import Path

# ── Test 1: Watermark round-trip ──────────────────────────
print("=== Test 1: Watermark round-trip ===")
from watermark import Watermarker, THRESHOLD

uid, ts = "user_42", int(time.time())
wm      = Watermarker(Path(__file__).parent / "watermark_embed.onnx")
audio   = np.sin(2 * 3.14159 * 440 * np.arange(22050) / 22050).astype("float32")

marked  = wm.embed(audio, uid, ts)
snr_db  = 20 * float(np.log10(
    np.linalg.norm(audio) / (np.linalg.norm(marked - audio) + 1e-8)
))
correct = wm.verify(marked, uid, ts)
wrong   = wm.verify(marked, "attacker", ts)

print(f"  SNR:              {snr_db:.1f} dB   (target > 40 dB)")
print(f"  Correct uid:      detected={correct['detected']}  corr={correct['correlation']:.4f}  ({correct['confidence']})")
print(f"  Wrong uid:        detected={wrong['detected']}    corr={wrong['correlation']:.4f}")
t1 = correct["detected"] and not wrong["detected"] and snr_db > 40
print(f"  RESULT: {'PASS' if t1 else 'FAIL'}\n")

# ── Test 2: Model encryption / decryption ─────────────────
print("=== Test 2: Model encryption (machine-bound key) ===")
from model_crypto import encrypt_file, decrypt_to_bytes, load_encrypted_session
import os, secrets

model_path = Path(__file__).parent / "model.onnx"
if not model_path.exists():
    print("  SKIP: model.onnx not found")
    sys.exit(0)

key_hex = secrets.token_hex(32)   # simulate a 256-bit key
enc_path = model_path.with_suffix(".enc")

# Encrypt
ep = encrypt_file(model_path, key_hex)
assert ep == enc_path, f"Expected {enc_path}, got {ep}"
assert enc_path.exists()
enc_size  = enc_path.stat().st_size
orig_size = model_path.stat().st_size
print(f"  Encrypted:        {orig_size} B → {enc_size} B  (overhead = {enc_size - orig_size} B, expect 28)")

# Decrypt with correct key → success
plain_back = decrypt_to_bytes(enc_path, key_hex)
assert plain_back == model_path.read_bytes(), "Decrypt produced different bytes!"
print(f"  Correct key:      decrypt OK, bytes match")

# Decrypt with wrong key → FAIL (AES-GCM auth error)
wrong_key = secrets.token_hex(32)
try:
    decrypt_to_bytes(enc_path, wrong_key)
    print("  Wrong key:        FAIL — should have raised!")
    t2 = False
except Exception as e:
    print(f"  Wrong key:        correctly rejected ({type(e).__name__})")
    t2 = True

# Verify ORT can load from encrypted file
sess = load_encrypted_session(enc_path, key_hex, providers=["CPUExecutionProvider"])
inputs  = [i.name for i in sess.get_inputs()]
outputs = [o.name for o in sess.get_outputs()]
print(f"  In-memory load:   inputs={inputs}  outputs={outputs}")
t2 = t2 and len(inputs) > 0

print(f"  RESULT: {'PASS' if t2 else 'FAIL'}\n")

# ── Test 3: Sandbox network block ─────────────────────────
print("=== Test 3: Sandbox network restriction ===")
import sandbox
sandbox.apply()
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    print("  FAIL — AF_INET socket creation should be blocked")
    t3 = False
except PermissionError as e:
    print(f"  AF_INET blocked:  OK ({e})")
    t3 = True
except Exception as e:
    print(f"  Unexpected error: {e}")
    t3 = False

print(f"  RESULT: {'PASS' if t3 else 'FAIL'}\n")

print("=== Summary ===")
all_pass = t1 and t2 and t3
print(f"  Watermark:   {'PASS' if t1 else 'FAIL'}")
print(f"  Encryption:  {'PASS' if t2 else 'FAIL'}")
print(f"  Sandbox:     {'PASS' if t3 else 'FAIL'}")
print(f"  OVERALL:     {'ALL PASS' if all_pass else 'SOME FAILED'}")
sys.exit(0 if all_pass else 1)
