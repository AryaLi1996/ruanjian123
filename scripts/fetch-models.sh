#!/usr/bin/env bash
# Download the pretrained weights the engine needs: the MDX-Net separator and
# the ContentVec content encoder.
#
# Neither is in git — 66 MB and 198 MB do not belong in repository history.
# The build downloads them and verifies their checksums, and electron-builder
# ships them inside the installer.
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

install_model() {
  # mktemp creates 0600 and mv preserves it; every other engine/*.onnx is
  # 0644. The bundled app may well be read by a different account than the
  # one that built it, so match the rest rather than shipping an owner-only
  # model.
  mv "$1" "$2"
  chmod 644 "$2"
}

# ── MDX-Net separator ────────────────────────────────────────────────────────

if [ -f "$DEST" ] && [ "$(sha_of "$DEST")" = "$MODEL_SHA256" ]; then
  echo "[fetch-models] $MODEL_NAME already present and verified."
else
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
  install_model "$TMP" "$DEST"
  trap - EXIT
  echo "[fetch-models] installed $DEST"
fi

# ── ContentVec content encoder ───────────────────────────────────────────────
#
# Converted here rather than downloaded ready-made. The published ONNX
# conversions are GPL-3.0 (MoeSS) or state no license (Xenova), and this is a
# closed-source product; converting the MIT checkpoint ourselves makes the
# license of what ships the license of what was downloaded.
#
# The checksum is of the *source* checkpoint, not the ONNX: torch.onnx.export
# is not guaranteed to be byte-identical across platforms and torch versions,
# so verifying its output would fail on a difference that does not matter.
# Verifying the input and checking the export against the module it came from
# (convert-contentvec.py does that) covers what the checksum is there for.

CV_NAME="contentvec-base-L6.onnx"
CV_SRC_SHA256="d8dd400e054ddf4e6be75dab5a2549db748cc99e756a097c496c099f65a4854e"
CV_REPO="https://huggingface.co/lengyue233/content-vec-best/resolve/main"
CV_DEST="$ENGINE_DIR/$CV_NAME"
CV_STAMP="$ENGINE_DIR/.$CV_NAME.source-sha256"

if [ -f "$CV_DEST" ] && [ -f "$CV_STAMP" ] && \
   [ "$(cat "$CV_STAMP")" = "$CV_SRC_SHA256" ]; then
  echo "[fetch-models] $CV_NAME already built from the expected checkpoint."
  exit 0
fi

PY_BIN="${PYTHON:-python3}"
echo "[fetch-models] preparing ContentVec conversion tools..."
"$PY_BIN" -m pip install --quiet "transformers>=4.30" onnxscript

WORK="$(mktemp -d "${TMPDIR:-/tmp}/contentvec.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "[fetch-models] downloading ContentVec checkpoint (~378 MB)..."
curl -fsSL --retry 3 --retry-delay 2 -o "$WORK/config.json" "$CV_REPO/config.json"
curl -fsSL --retry 3 --retry-delay 2 -o "$WORK/pytorch_model.bin" "$CV_REPO/pytorch_model.bin"

CV_ACTUAL="$(sha_of "$WORK/pytorch_model.bin")"
if [ "$CV_ACTUAL" != "$CV_SRC_SHA256" ]; then
  echo "[fetch-models] CHECKSUM MISMATCH for the ContentVec checkpoint" >&2
  echo "[fetch-models]   expected $CV_SRC_SHA256" >&2
  echo "[fetch-models]   actual   $CV_ACTUAL" >&2
  exit 1
fi

echo "[fetch-models] converting to $CV_NAME..."
"$PY_BIN" "$ROOT/scripts/convert-contentvec.py" "$WORK" "$WORK/$CV_NAME"
install_model "$WORK/$CV_NAME" "$CV_DEST"
printf '%s' "$CV_SRC_SHA256" > "$CV_STAMP"
rm -rf "$WORK"
trap - EXIT
echo "[fetch-models] installed $CV_DEST"
