"""
Python-level sandbox applied before any engine imports.

Restrictions applied:
  1. Outbound TCP/UDP blocked (AF_INET/AF_INET6 sockets raise PermissionError).
     AF_UNIX is allowed — both creation *and* connect — so ORT can talk to
     CoreML / local runtimes and PyTorch's DataLoader workers can hand file
     descriptors back to the parent process.
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

        # Explicit block on connect in case __init__ is bypassed — a socket
        # built from an existing fd (fileno=) never goes through the family
        # check above, so the real family is re-checked here.
        #
        # Ticket T1: this used to reject *every* connect, including AF_UNIX,
        # which contradicts the family allow-list above and broke training
        # outright: PyTorch's DataLoader workers pass tensor file descriptors
        # to the parent over an AF_UNIX socket (multiprocessing's
        # resource_sharer), so the first batch of any num_workers > 0 run died
        # with "DataLoader worker (pid NNNN) exited unexpectedly". A unix
        # socket cannot reach the network, so allowing it costs nothing
        # against the threat this sandbox exists for (outbound egress).
        def _require_local(self, action: str, address) -> None:
            if self.family not in _ALLOWED_FAMILIES:
                raise PermissionError(
                    f"Engine sandbox: outbound {action} blocked → {address}")

        def connect(self, address):
            self._require_local("connect", address)
            return super().connect(address)

        def connect_ex(self, address):
            self._require_local("connect_ex", address)
            return super().connect_ex(address)

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
