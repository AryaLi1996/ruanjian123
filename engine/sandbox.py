"""
Python-level sandbox applied before any engine imports.

Restrictions applied:
  1. Outbound TCP/UDP blocked (AF_INET/AF_INET6 sockets raise PermissionError).
     AF_UNIX is allowed so ORT can communicate with CoreML / local runtimes.
  2. HTTP proxy environment variables removed so libraries cannot bypass (1).
  3. PYTHONNOUSERSITE=1 prevents user site-packages from loading.

Note: this is a *best-effort* software sandbox — a fully isolated environment
requires OS-level facilities (macOS sandbox-exec, Linux seccomp).  Apply this
module *as early as possible* (before any import that opens a network socket).
"""
from __future__ import annotations

import os
import socket as _socket
import sys

_APPLIED = False


def apply() -> None:
    global _APPLIED
    if _APPLIED:
        return

    # ── 1. Block outbound network sockets ───────────────────
    _OrigSocket = _socket.socket
    _ALLOWED_FAMILIES = {_socket.AF_UNIX}   # AF_UNIX = local IPC only

    class _SandboxSocket(_OrigSocket):
        def __init__(self, family=_socket.AF_INET, type_=_socket.SOCK_STREAM,
                     proto=0, fileno=None):
            if family not in _ALLOWED_FAMILIES:
                raise PermissionError(
                    f"Engine sandbox: network socket blocked "
                    f"(family={family}). Only AF_UNIX is allowed."
                )
            super().__init__(family, type_, proto, fileno)

        # Explicit block on connect in case __init__ is bypassed
        def connect(self, address):
            raise PermissionError(f"Engine sandbox: outbound connect blocked → {address}")

        def connect_ex(self, address):
            raise PermissionError(f"Engine sandbox: outbound connect_ex blocked → {address}")

    _socket.socket = _SandboxSocket  # type: ignore[assignment]
    # Also patch the module-level shortcut
    if hasattr(_socket, 'create_connection'):
        def _blocked_create(*_a, **_kw):
            raise PermissionError("Engine sandbox: create_connection blocked")
        _socket.create_connection = _blocked_create  # type: ignore[assignment]

    # ── 2. Strip proxy vars ──────────────────────────────────
    for var in ('HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'ALL_PROXY',
                'http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy'):
        os.environ.pop(var, None)
    os.environ['no_proxy'] = '*'
    os.environ['NO_PROXY']  = '*'

    # ── 3. No user site-packages ─────────────────────────────
    os.environ['PYTHONNOUSERSITE'] = '1'

    _APPLIED = True
