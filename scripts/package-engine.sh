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
#
# macOS universal builds:
#   A PyInstaller bundle embeds native, single-architecture binaries (the
#   Python.framework runtime itself, plus compiled extensions in numpy /
#   onnxruntime / torch / etc). It cannot be made "universal" by just running
#   this script once — @electron/universal's merge step needs a genuinely
#   different, correctly-native bundle for each architecture to lipo
#   together. Set ENGINE_ARCH=arm64|x64 (macOS only) to build one arch into
#   its own isolated venv + output dir:
#     ENGINE_ARCH=arm64 bash scripts/package-engine.sh
#     ENGINE_ARCH=x64   bash scripts/package-engine.sh
#   Output goes to resources/engine-dist-<arch> in that case. Building x64
#   requires a universal2 (or x86_64) Python 3 available to run under
#   Rosetta — see find_x64_python() below. Leave ENGINE_ARCH unset for the
#   original single-output behavior (resources/engine-dist), unchanged for
#   Windows/Linux and for non-universal macOS builds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_DIR="$ROOT/engine"

ENGINE_ARCH="${ENGINE_ARCH:-}"
if [ -n "$ENGINE_ARCH" ] && [ "$(uname -s)" != "Darwin" ]; then
  echo "[package-engine] ENGINE_ARCH is only meaningful on macOS — ignoring on $(uname -s)." >&2
  ENGINE_ARCH=""
fi

if [ -n "$ENGINE_ARCH" ]; then
  case "$ENGINE_ARCH" in
    arm64|x64) ;;
    *) echo "[package-engine] ENGINE_ARCH must be 'arm64' or 'x64', got '$ENGINE_ARCH'" >&2; exit 1 ;;
  esac
  OUT_DIR="$ROOT/resources/engine-dist-$ENGINE_ARCH"
else
  OUT_DIR="$ROOT/resources/engine-dist"
fi
DIST_DIR="$OUT_DIR/ruanjian-engine"
STAMP="$OUT_DIR/.source-hash"

# Windows detection, for the things that genuinely differ there: PyInstaller's
# --add-data separator, and the .exe suffix on its output executable. Under
# Git Bash / MSYS (what GitHub's windows-latest runner and most local Windows
# bash setups use), `uname -s` reports something like "MINGW64_NT-10.0...",
# not "Windows" — match the MSYS/MINGW/Cygwin family.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
  *)                    IS_WINDOWS=0 ;;
esac
ADD_DATA_SEP=":"
ENGINE_EXE_NAME="ruanjian-engine"
if [ "$IS_WINDOWS" = 1 ]; then
  ADD_DATA_SEP=";"
  ENGINE_EXE_NAME="ruanjian-engine.exe"
fi

# `shasum` (a Perl script) ships with macOS and most Linux distros, but not
# with Git for Windows' bash — that only has `sha256sum` (GNU coreutils).
# Both print "<hash>  <filename>" (or "<hash>  -" reading stdin) and are used
# identically below; an array (not a shell function) is needed since these
# get spliced into `find -exec ... \;`, which needs a literal command.
if command -v shasum >/dev/null 2>&1; then
  SHA_CMD=(shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD=(sha256sum)
else
  echo "[package-engine] Neither shasum nor sha256sum found on PATH." >&2
  exit 1
fi

# Skip the (multi-minute) PyInstaller rebuild when nothing the bundle depends
# on has actually changed since the last successful build. Pass --force (or
# set FORCE_ENGINE_REBUILD=1) to bypass this and rebuild unconditionally.
FORCE_REBUILD="${FORCE_ENGINE_REBUILD:-0}"
[ "${1:-}" = "--force" ] && FORCE_REBUILD=1

if [ "$FORCE_REBUILD" != 1 ] && [ -x "$DIST_DIR/$ENGINE_EXE_NAME" ] && [ -f "$STAMP" ]; then
  CURRENT_HASH="$(
    find "$ENGINE_DIR" \( -name '*.py' -o -name '*.onnx' -o -name 'requirements.txt' \) -type f \
      -exec "${SHA_CMD[@]}" {} \; | sort | "${SHA_CMD[@]}" | awk '{print $1}'
  )"
  if [ "$CURRENT_HASH" = "$(cat "$STAMP")" ]; then
    echo "[package-engine] No changes in engine/ since last build — skipping PyInstaller (use --force to override)."
    exit 0
  fi
fi

# PY is the argv prefix used for every python invocation below. For the
# unversioned (no ENGINE_ARCH) path this is just the system Python, exactly
# as before. For an arch-specific macOS build it points at a dedicated venv,
# built and locked to that architecture, so x64 and arm64 dependency trees
# never share (and corrupt) a single site-packages directory.
#
# Windows Python installs (python.org installer, actions/setup-python, the
# Microsoft Store package) register the command as `python`, not `python3`
# — `python3` is a macOS/Linux convention. Prefer python3 where it exists
# (keeps picking the right interpreter on a machine that has both python
# 2 and 3 on PATH) and fall back to python otherwise.
if command -v python3 >/dev/null 2>&1; then
  PY=(python3)
elif command -v python >/dev/null 2>&1; then
  PY=(python)
else
  echo "[package-engine] No python3/python interpreter found on PATH." >&2
  exit 1
fi

# Finds a Python 3 binary that can actually execute the x86_64 slice under
# Rosetta — i.e. a universal2 build (python.org installer) or a native
# x86_64-only interpreter. The plain Apple Silicon Homebrew/CLT python3 is
# arm64-only and will fail here.
find_x64_python() {
  local candidates=(
    /usr/local/bin/python3.11
    /usr/local/bin/python3
    /Library/Frameworks/Python.framework/Versions/3.11/bin/python3
    /opt/homebrew/bin/python3.11
  )
  for c in "${candidates[@]}"; do
    if [ -x "$c" ] && arch -x86_64 "$c" -c 'pass' >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

if [ -n "$ENGINE_ARCH" ]; then
  VENV_DIR="$ROOT/.build-venv-engine-$ENGINE_ARCH"

  if [ "$ENGINE_ARCH" = "x64" ]; then
    if [ ! -x "$VENV_DIR/bin/python3" ]; then
      BASE_PY="$(find_x64_python)" || {
        echo "[package-engine] No Python 3 build on this machine can run the x86_64 slice under Rosetta." >&2
        echo "[package-engine] Install a universal2 Python (e.g. the python.org macOS installer) and retry." >&2
        exit 1
      }
      echo "[package-engine] Creating x64 build venv from $BASE_PY (via Rosetta)..."
      arch -x86_64 "$BASE_PY" -m venv "$VENV_DIR"
    fi
    # A venv's python3 is a (fat, universal2) copy/symlink of its base
    # interpreter — invoking it directly runs the host's native arch, so
    # every call must still be forced through Rosetta explicitly.
    PY=(arch -x86_64 "$VENV_DIR/bin/python3")
  else
    if [ ! -x "$VENV_DIR/bin/python3" ]; then
      echo "[package-engine] Creating arm64 build venv..."
      python3 -m venv "$VENV_DIR"
    fi
    PY=("$VENV_DIR/bin/python3")
  fi

  ACTUAL_ARCH="$("${PY[@]}" -c 'import platform; print(platform.machine())')"
  EXPECTED_ARCH="$([ "$ENGINE_ARCH" = "x64" ] && echo x86_64 || echo arm64)"
  if [ "$ACTUAL_ARCH" != "$EXPECTED_ARCH" ]; then
    echo "[package-engine] Build venv reports arch '$ACTUAL_ARCH', expected '$EXPECTED_ARCH' — refusing to continue." >&2
    exit 1
  fi

  echo "[package-engine] Installing engine dependencies for $ENGINE_ARCH (this can take a while, esp. torch)..."
  "${PY[@]}" -m pip install --quiet --upgrade pip

  # Every package that ships a compiled/native component is pinned to an
  # exact, matched version across BOTH macOS legs. requirements.txt leaves
  # torch, numpy, cryptography, and onnxruntime unconstrained, so pip
  # resolves each independently per leg — and even when both legs land on
  # a wheel, "newest available" isn't the same release on both, because
  # PyTorch stopped publishing x86_64 macOS wheels after 2.2.2 (Apple
  # Silicon is the priority target now) while the other packages just drift
  # normally over time. A universal build needs the two legs' file trees to
  # line up exactly — @electron/universal only lipos *matching* filenames;
  # anything unique to one side (a "cryptography-50.0.0.dist-info" next to
  # a "cryptography-48.0.1.dist-info", or "libonnxruntime.1.28.0.dylib" next
  # to "libonnxruntime.1.23.2.dylib") is a hard error, not a mismatch it
  # resolves for you. Pin to whatever versions the more-constrained x64 leg
  # (fewer wheels published for it) can satisfy, since arm64 can always
  # match down to an older release too.
  TORCH_PIN='torch==2.2.2'
  NUMPY_PIN='numpy<2'
  CRYPTOGRAPHY_PIN='cryptography==48.0.1'
  ONNXRUNTIME_PIN='onnxruntime==1.23.2'
  SETUPTOOLS_PIN='setuptools==65.5.0'
  # --only-binary=:all: forces wheel-only installs. Without it, pip silently
  # falls back to building a package from source (sdist) whenever it can't
  # find a matching prebuilt wheel — which for a Rosetta-run x86_64 venv can
  # happen even though a compatible wheel exists on PyPI (e.g. the resolver
  # backtracking to an older release that predates cp311 wheels). A source
  # build of something like cryptography needs a Rust toolchain, which this
  # machine doesn't have, and even when it succeeds it's dramatically slower
  # under emulation. Fail fast and loud instead of quietly grinding for an
  # hour (or hanging) on a from-source build during a bundling script.
  CONSTRAINTS_FILE="$(mktemp)"
  printf '%s\n' "$TORCH_PIN" "$NUMPY_PIN" "$CRYPTOGRAPHY_PIN" "$ONNXRUNTIME_PIN" "$SETUPTOOLS_PIN" > "$CONSTRAINTS_FILE"
  "${PY[@]}" -m pip install --quiet --only-binary=:all: -c "$CONSTRAINTS_FILE" -r "$ENGINE_DIR/requirements.txt" \
    pyinstaller "$TORCH_PIN" "$CRYPTOGRAPHY_PIN" "$ONNXRUNTIME_PIN" "$SETUPTOOLS_PIN"
  rm -f "$CONSTRAINTS_FILE"
fi

echo "[package-engine] Checking PyInstaller..."
if ! "${PY[@]}" -m PyInstaller --version >/dev/null 2>&1; then
  echo "[package-engine] Installing PyInstaller..."
  "${PY[@]}" -m pip install pyinstaller --quiet
fi

echo "[package-engine] Building standalone engine bundle..."
cd "$ENGINE_DIR"

# Collect all .onnx files as data assets
ONNX_ARGS=()
for f in *.onnx; do
  [ -f "$f" ] && ONNX_ARGS+=("--add-data" "$f$ADD_DATA_SEP.")
done

"${PY[@]}" -m PyInstaller main.py \
  --name          ruanjian-engine \
  --onedir \
  "${ONNX_ARGS[@]}" \
  --add-data      "*.py$ADD_DATA_SEP." \
  --hidden-import soundfile \
  --hidden-import onnxruntime \
  --hidden-import numpy \
  --hidden-import cryptography \
  --hidden-import torch \
  --hidden-import paths \
  --distpath      "$OUT_DIR" \
  --workpath      "/tmp/pyinstaller-work-ruanjian${ENGINE_ARCH:+-$ENGINE_ARCH}" \
  --noconfirm \
  --log-level     WARN

find "$ENGINE_DIR" \( -name '*.py' -o -name '*.onnx' -o -name 'requirements.txt' \) -type f \
  -exec "${SHA_CMD[@]}" {} \; | sort | "${SHA_CMD[@]}" | awk '{print $1}' > "$STAMP"

SIZE=$(du -sh "$DIST_DIR" | cut -f1)
echo "[package-engine] Done. Bundle: $DIST_DIR/$ENGINE_EXE_NAME ($SIZE)"

# --- Cross-arch reconciliation (macOS universal builds only) ---------------
#
# A handful of files exist on only ONE of the two arch legs by construction,
# not by version drift, so no amount of dependency pinning above fixes them:
#   - soundfile bundles its native libsndfile build under an arch-embedded
#     filename (libsndfile_arm64.dylib / libsndfile_x86_64.dylib) — the two
#     builds literally have different relative paths, not just different
#     content at the same path.
#   - torch's OpenMP runtime differs per arch: the x86_64 build links Intel
#     MKL's libiomp5.dylib (in both torch/lib/ and functorch/.dylibs/), the
#     arm64 build uses LLVM's libomp.dylib instead (functorch/.dylibs/ only)
#     and has nothing at torch/lib/libiomp5.dylib at all.
#
# electron-builder builds each arch leg into its own resources/engine-dist-*
# directory, which it then copies verbatim into each per-arch .app before
# @electron/universal compares the two .app trees file-by-file and hard-
# errors on any relative path that exists on only one side (there is no
# config-level way to whitelist that for extraResources — mac.singleArchFiles
# only applies inside app.asar, which this project doesn't use for the
# engine). So the source directories themselves need to already contain the
# union of both sides' files before electron-builder ever touches them:
# each side gets an inert copy of the other's arch-specific binary (dead
# weight, never loaded — the app only dlopens the file matching its own
# runtime arch). mac.x64ArchFiles in electron-builder.js then tells
# @electron/universal these particular now-identical-on-both-sides Mach-O
# files are expected, not a merge conflict.
if [ -n "$ENGINE_ARCH" ]; then
  ARM64_DIST="$ROOT/resources/engine-dist-arm64/ruanjian-engine/_internal"
  X64_DIST="$ROOT/resources/engine-dist-x64/ruanjian-engine/_internal"
  if [ -d "$ARM64_DIST" ] && [ -d "$X64_DIST" ]; then
    echo "[package-engine] Both arch legs present — reconciling arch-specific files..."
    # "arm64-side relative path:x64-side relative path" pairs. Where a file
    # has no natural counterpart on the other side (torch/lib/libiomp5.dylib),
    # the missing half of the pair is left blank and that side just receives
    # a copy under the same path.
    RECONCILE_PAIRS=(
      "_soundfile_data/libsndfile_arm64.dylib:_soundfile_data/libsndfile_x86_64.dylib"
      "functorch/.dylibs/libomp.dylib:functorch/.dylibs/libiomp5.dylib"
      ":torch/lib/libiomp5.dylib"
    )
    for pair in "${RECONCILE_PAIRS[@]}"; do
      arm64_rel="${pair%%:*}"
      x64_rel="${pair#*:}"
      if [ -n "$arm64_rel" ] && [ -f "$ARM64_DIST/$arm64_rel" ] && [ ! -f "$X64_DIST/$arm64_rel" ]; then
        mkdir -p "$(dirname "$X64_DIST/$arm64_rel")"
        cp "$ARM64_DIST/$arm64_rel" "$X64_DIST/$arm64_rel"
        echo "[package-engine]   copied arm64 -> x64: $arm64_rel"
      fi
      if [ -n "$x64_rel" ] && [ -f "$X64_DIST/$x64_rel" ] && [ ! -f "$ARM64_DIST/$x64_rel" ]; then
        mkdir -p "$(dirname "$ARM64_DIST/$x64_rel")"
        cp "$X64_DIST/$x64_rel" "$ARM64_DIST/$x64_rel"
        echo "[package-engine]   copied x64 -> arm64: $x64_rel"
      fi
    done

    # A few files exist on BOTH sides already but come out byte-different
    # despite being built from identical source — PyInstaller's
    # base_library.zip (a zip of compiled stdlib .pyc files) isn't packed
    # deterministically: same file listing and size on both legs, different
    # SHA, purely from zip-entry ordering/timestamps. Since compiled Python
    # bytecode itself has no CPU-architecture dependency (unlike the native
    # .dylibs above, it's interpreted, not compiled machine code), it's safe
    # to just force one side's copy onto the other rather than special-case
    # it like the Mach-O files above.
    FORCE_IDENTICAL=(
      "base_library.zip"
    )
    for rel in "${FORCE_IDENTICAL[@]}"; do
      if [ -f "$ARM64_DIST/$rel" ] && [ -f "$X64_DIST/$rel" ]; then
        if ! cmp -s "$ARM64_DIST/$rel" "$X64_DIST/$rel"; then
          cp "$ARM64_DIST/$rel" "$X64_DIST/$rel"
          echo "[package-engine]   forced identical (arm64 -> x64): $rel"
        fi
      fi
    done

    # Same idea, generalized: every *.dist-info/RECORD (and any other file
    # pip writes into a *.dist-info dir) can differ across the two legs even
    # when the package version is pinned identically, because pip's
    # auto-generated RECORD embeds the sha256 of every other file it
    # installed — including that same package's compiled .so/.dylib
    # extension, which is legitimately different content per architecture.
    # This will recur for every native-extension dependency in the tree
    # (markupsafe, cffi, ml_dtypes, ...), not just the specific one that
    # happens to sort first, so reconcile the whole category at once rather
    # than adding one hardcoded filename per package as each surfaces.
    # dist-info contents are pip/wheel install metadata only — a frozen
    # PyInstaller app never reads them at runtime — so it's safe to just
    # pick one side's copy for anything that differs.
    while IFS= read -r -d '' arm64_file; do
      rel="${arm64_file#"$ARM64_DIST"/}"
      x64_file="$X64_DIST/$rel"
      if [ -f "$x64_file" ] && ! cmp -s "$arm64_file" "$x64_file"; then
        cp "$arm64_file" "$x64_file"
        echo "[package-engine]   forced identical (arm64 -> x64): $rel"
      fi
    done < <(find "$ARM64_DIST" -path '*.dist-info/*' -type f -print0)

    echo "[package-engine] Reconciliation done."
  fi
fi
