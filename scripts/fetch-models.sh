#!/usr/bin/env bash
# Download the pretrained separation weights the engine needs.
#
# These are not in git: the MDX-Net model is 66 MB, which does not belong in
# repository history. The build downloads it and verifies its checksum, and
# electron-builder ships it inside the installer.
#
# It has to ship, not download on demand: engine/sandbox.py blocks outbound
# sockets, so the packaged app can never fetch this itself. Without the file
# separation falls back to a placeholder whose vocal stem contains no voice,
# and reports degraded=true so that is visible rather than silent.
#
# Run before scripts/package-engine.sh. Safe to re-run: an existing file with
# the right checksum is left alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="$ROOT/engine"

MODEL_NAME="UVR-MDX-NET-Inst_HQ_3.onnx"
MODEL_SHA256="317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc"
MODEL_URL="https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/${MODEL_NAME}"

DEST="$ENGINE_DIR/$MODEL_NAME"

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

if [ -f "$DEST" ] && [ "$(sha_of "$DEST")" = "$MODEL_SHA256" ]; then
  echo "[fetch-models] $MODEL_NAME already present and verified."
  exit 0
fi

echo "[fetch-models] downloading $MODEL_NAME (~66 MB)..."
TMP="$(mktemp "${TMPDIR:-/tmp}/mdx.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
curl -fsSL --retry 3 --retry-delay 2 -o "$TMP" "$MODEL_URL"

ACTUAL="$(sha_of "$TMP")"
if [ "$ACTUAL" != "$MODEL_SHA256" ]; then
  echo "[fetch-models] CHECKSUM MISMATCH for $MODEL_NAME" >&2
  echo "[fetch-models]   expected $MODEL_SHA256" >&2
  echo "[fetch-models]   actual   $ACTUAL" >&2
  exit 1
fi

mv "$TMP" "$DEST"
trap - EXIT
echo "[fetch-models] installed $DEST"
