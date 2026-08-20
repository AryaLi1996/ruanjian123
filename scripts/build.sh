#!/usr/bin/env bash
# Full production build: bundle Python engine → compile renderer + main → electron-builder
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[build] Step 1/4 — Install Node dependencies..."
npm ci --cache "$TMPDIR/npm-cache" 2>/dev/null || npm ci

echo "[build] Step 2/4 — Bundle Python engine (PyInstaller)..."
bash scripts/package-engine.sh

echo "[build] Step 3/4 — Compile renderer + main (electron-vite)..."
npx electron-vite build

echo "[build] Step 4/4 — Package installer (electron-builder)..."
npx electron-builder

# Ticket 41: catch a Windows build that's missing Electron-runtime files
# (ffmpeg.dll in particular) before it ships — see
# scripts/verify-win-package.mjs for why. No-op when this build didn't
# target Windows (dist/win-unpacked won't exist).
if [ -d dist/win-unpacked ]; then
  echo "[build] Verifying packaged Windows runtime files..."
  node scripts/verify-win-package.mjs dist/win-unpacked
fi

echo "[build] Done. Artifacts are in dist/"
ls -lh dist/*.{dmg,exe,AppImage,deb} 2>/dev/null || true
