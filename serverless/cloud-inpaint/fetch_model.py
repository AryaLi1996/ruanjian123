"""
Fetch the ONNX model into the image, refusing anything but the exact bytes.

A build step rather than a line in the Dockerfile for two reasons. A `RUN`
here-document needs BuildKit, and `sam build` does not promise to use it — a
Dockerfile that only builds under one builder is a deploy that fails on
somebody else's machine. And writing it out means the checksum check is real
code with a real failure message rather than a shell pipeline whose exit status
is easy to lose.

Neither `curl` nor `sha256sum` is guaranteed present in a Lambda base image.
The interpreter is.

    python fetch_model.py <url> <sha256> <destination>
"""
from __future__ import annotations

import hashlib
import sys
import time
import urllib.request

CHUNK = 1 << 20

# 208 MB is far enough to go wrong. Writing this, one transfer in five came
# back the right length and the wrong bytes — which is exactly what the
# checksum is for, and also exactly the kind of failure that should cost a
# retry rather than a whole deploy. Three attempts; a mismatch that survives
# all three is a real problem with the URL or the recorded hash, not weather.
ATTEMPTS = 3
BACKOFF_SECONDS = 5


def fetch(url: str, destination: str) -> str:
    """Download to `destination`, returning what it actually hashes to."""
    digest = hashlib.sha256()
    with urllib.request.urlopen(url) as reply, open(destination, 'wb') as out:
        while chunk := reply.read(CHUNK):
            digest.update(chunk)
            out.write(chunk)
    return digest.hexdigest()


def main(url: str, expected: str, destination: str) -> int:
    for attempt in range(1, ATTEMPTS + 1):
        got = fetch(url, destination)
        if got == expected:
            print(f'model ok: {got}')
            return 0
        # Streamed straight to disk, so the bad bytes are already written. The
        # next attempt truncates the file; the last one leaves it there and
        # fails, which is fine because the layer fails with it.
        print(f'attempt {attempt}/{ATTEMPTS}: model checksum is {got}, '
              f'expected {expected}', file=sys.stderr)
        if attempt < ATTEMPTS:
            time.sleep(BACKOFF_SECONDS)
    return 1


if __name__ == '__main__':
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(*sys.argv[1:]))
