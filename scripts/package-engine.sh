#!/usr/bin/env bash
# Bundle the Python engine into a standalone executable using PyInstaller.
# Output: resources/engine-dist/ruanjian-engine/{ruanjian-engine[.exe], ...}
#
# This is called by scripts/build.sh before electron-builder runs.
# The output is included via electron-builder extraResources → engine-dist.
#
# Platforms:
#   macOS / Linux : produces ruanjian-engine binary
#   Windows       : produces ruanjian-engine.exe  (run via cmd /c)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_DIR="$ROOT/engine"
OUT_DIR="$ROOT/resources/engine-dist"
DIST_DIR="$OUT_DIR/ruanjian-engine"
STAMP="$OUT_DIR/.source-hash"

# Skip the (multi-minute) PyInstaller rebuild when nothing the bundle depends
# on has actually changed since the last successful build. Pass --force (or
# set FORCE_ENGINE_REBUILD=1) to bypass this and rebuild unconditionally.
FORCE_REBUILD="${FORCE_ENGINE_REBUILD:-0}"
[ "${1:-}" = "--force" ] && FORCE_REBUILD=1

if [ "$FORCE_REBUILD" != 1 ] && [ -x "$DIST_DIR/ruanjian-engine" ] && [ -f "$STAMP" ]; then
  CURRENT_HASH="$(
    find "$ENGINE_DIR" \( -name '*.py' -o -name '*.onnx' -o -name 'requirements.txt' \) -type f \
      -exec shasum -a 256 {} \; | sort | shasum -a 256 | awk '{print $1}'
  )"
  if [ "$CURRENT_HASH" = "$(cat "$STAMP")" ]; then
    echo "[package-engine] No changes in engine/ since last build — skipping PyInstaller (use --force to override)."
    exit 0
  fi
fi

echo "[package-engine] Checking PyInstaller..."
if ! python3 -m PyInstaller --version >/dev/null 2>&1; then
  echo "[package-engine] Installing PyInstaller..."
  python3 -m pip install pyinstaller --quiet
fi

echo "[package-engine] Building standalone engine bundle..."
cd "$ENGINE_DIR"

# Collect all .onnx files as data assets
ONNX_ARGS=()
for f in *.onnx; do
  [ -f "$f" ] && ONNX_ARGS+=("--add-data" "$f:.")
done

python3 -m PyInstaller main.py \
  --name          ruanjian-engine \
  --onedir \
  "${ONNX_ARGS[@]}" \
  --add-data      "*.py:." \
  --hidden-import soundfile \
  --hidden-import onnxruntime \
  --hidden-import numpy \
  --hidden-import cryptography \
  --hidden-import torch \
  --hidden-import paths \
  --distpath      "$OUT_DIR" \
  --workpath      "/tmp/pyinstaller-work-ruanjian" \
  --noconfirm \
  --log-level     WARN

find "$ENGINE_DIR" \( -name '*.py' -o -name '*.onnx' -o -name 'requirements.txt' \) -type f \
  -exec shasum -a 256 {} \; | sort | shasum -a 256 | awk '{print $1}' > "$STAMP"

SIZE=$(du -sh "$DIST_DIR" | cut -f1)
echo "[package-engine] Done. Bundle: $DIST_DIR ($SIZE)"
