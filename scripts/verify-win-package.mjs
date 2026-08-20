#!/usr/bin/env node
// Ticket 41: verify a packaged Windows build actually contains the
// Electron-runtime files it needs to launch — ffmpeg.dll in particular
// (the "由于找不到ffmpeg.dll，无法继续执行代码" launch failure this ticket is
// about), plus the bundled Python engine executable.
//
// Investigation found no ffmpeg dependency anywhere in this app's own code:
// no ffmpeg-static / fluent-ffmpeg / imageio-ffmpeg in package.json, and
// the Python engine only uses `soundfile` (libsndfile) for audio I/O —
// never ffmpeg/pydub/librosa/audioread (see engine/requirements.txt). So a
// missing ffmpeg.dll means Electron's own Chromium distribution shipped
// incomplete — most commonly antivirus quarantining it out of the unpacked
// app directory (ffmpeg.dll is a common false-positive target) or a
// corrupted install/extraction — not a missing dependency to add.
//
// Run this right after electron-builder packages a Windows target so a
// broken build fails the build/CI step loudly instead of silently shipping
// to users. See scripts/build.sh and .github/workflows/build-windows.yml
// for how this is wired in.
//
// Usage: node scripts/verify-win-package.mjs [path-to-win-unpacked]
//   Defaults to dist/win-unpacked, which is what electron-builder produces
//   for a single-arch (x64-only) Windows target — both the `portable` and
//   `nsis` targets this project uses assemble that directory as an
//   intermediate step before wrapping it into the final installer/exe, so
//   checking it here covers either target.

import { existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// electron-builder.js is a CommonJS module (`module.exports = config`) —
// dynamic import() of a CJS file from ESM hands back its exports under
// `.default`. Node's ESM loader requires a file:// URL for absolute paths on
// Windows — passing a bare "D:\..." path is parsed as a URL with scheme
// "d:" and throws ERR_UNSUPPORTED_ESM_URL_SCHEME (this actually broke the
// very first run of this script in CI, on build-windows.yml — see PR
// history). pathToFileURL() handles the conversion correctly on every
// platform, so use it instead of a raw path unconditionally.
const { default: builderConfig } = await import(pathToFileURL(join(ROOT, 'electron-builder.js')).href)
const productName = builderConfig.productName

const outDir = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : join(ROOT, 'dist', 'win-unpacked')

if (!existsSync(outDir)) {
  console.error(`[verify-win-package] output directory not found: ${outDir}`)
  console.error('[verify-win-package] nothing to verify — did electron-builder actually produce a Windows build?')
  process.exit(1)
}

// Electron's own Chromium distribution ships these next to the renamed main
// executable. ffmpeg.dll is the one this ticket is about; the rest are
// equally load-bearing native files from the same distribution, checked as
// a cheap way to catch the same class of packaging/extraction damage
// before it reaches a user.
const REQUIRED_ELECTRON_RUNTIME_FILES = [
  `${productName}.exe`,
  'ffmpeg.dll',
  'd3dcompiler_47.dll',
  'libEGL.dll',
  'libGLESv2.dll',
  'resources.pak',
  'icudtl.dat',
]

// The bundled PyInstaller engine (Ticket 39) — win.extraResources in
// electron-builder.js copies resources/engine-dist into the packaged app's
// resources/engine-dist.
const REQUIRED_ENGINE_FILES = [
  join('resources', 'engine-dist', 'ruanjian-engine', 'ruanjian-engine.exe'),
]

const missing = [...REQUIRED_ELECTRON_RUNTIME_FILES, ...REQUIRED_ENGINE_FILES]
  .filter((rel) => !existsSync(join(outDir, rel)))

if (missing.length > 0) {
  console.error(`[verify-win-package] MISSING required file(s) in ${outDir}:`)
  for (const m of missing) console.error(`  - ${m}`)
  console.error('[verify-win-package] contents of output directory:')
  try {
    for (const entry of readdirSync(outDir)) console.error(`  ${entry}`)
  } catch {
    console.error('  (could not list directory)')
  }
  console.error(
    '[verify-win-package] This build would fail to launch on a clean Windows machine ' +
    '(Ticket 41: "找不到ffmpeg.dll" / "ffmpeg.dll not found"). Do not publish this artifact.',
  )
  process.exit(1)
}

const total = REQUIRED_ELECTRON_RUNTIME_FILES.length + REQUIRED_ENGINE_FILES.length
console.log(`[verify-win-package] OK — all ${total} required files present in ${outDir}`)
