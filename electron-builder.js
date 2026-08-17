/** @type {import('electron-builder').Configuration} */

const path = require('path')
const { execFileSync } = require('child_process')

// A real Developer ID must be supplied explicitly; auto-discovered self-signed
// certs produce bundles that fail SecCodeCheckValidity and won't launch. Turn
// off auto-discovery so electron-builder can't grab one of those from the
// keychain.
const hasSigningCert = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)
if (!hasSigningCert) {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
}

const config = {
  appId:       'com.ruanjian.app',
  productName: 'Ruanjian',
  copyright:   'Copyright © 2026',

  directories: { buildResources: 'build', output: 'dist' },

  files: ['out/**/*', 'node_modules/**/*', 'package.json'],

  extraResources: [
    // Python scripts + ONNX models (always included)
    {
      from: 'engine',
      to:   'engine',
      filter: [
        '**/*.py',
        '**/*.onnx',
        'requirements.txt',
        '!__pycache__/**',
        '!*.pyc',
        '!_test_data/**',
        '!_test_*.py',
        '!_bench.py',
        '!_train_log*.txt',
        '!*.enc',
      ],
    },
    // NOTE: the PyInstaller standalone engine (built by
    // scripts/package-engine.sh) is intentionally NOT listed here. It embeds
    // native, architecture-specific binaries, so each platform declares its
    // own copy below (mac.extraResources / win.extraResources /
    // linux.extraResources) instead of sharing one platform-agnostic entry.
    // macOS in particular needs a genuinely different bundle per arch — see
    // the comment on mac.extraResources — which a shared entry can't express.
  ],

  mac: {
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    category:           'public.app-category.productivity',
    // PyInstaller standalone engine (built by scripts/package-engine.sh).
    // Absent in dev — python-bridge falls back to system python3.
    //
    // ${arch} is resolved per pack pass (electron-builder builds x64 and
    // arm64 separately, even for --universal, then merges). Point each pass
    // at its own arch-specific bundle — resources/engine-dist-x64 /
    // resources/engine-dist-arm64, produced by:
    //   ENGINE_ARCH=x64   bash scripts/package-engine.sh
    //   ENGINE_ARCH=arm64 bash scripts/package-engine.sh
    // Using one shared bundle here (as Windows/Linux do) works fine for a
    // single-arch dmg, but for --universal it either makes
    // @electron/universal's merge fail (identical "different-arch" Mach-O
    // files) or, if bypassed, silently ships a wrong-arch engine that can't
    // execute on the other CPU.
    extraResources: [
      {
        from:   'resources/engine-dist-${arch}',
        to:     'engine-dist',
        filter: ['**/*'],
      },
    ],
    // A few native libs inside the engine bundle are arch-specific by
    // construction (soundfile's libsndfile_<arch>.dylib naming; torch's
    // per-arch OpenMP runtime choice — Intel MKL's libiomp5.dylib on x64,
    // LLVM's libomp.dylib on arm64). scripts/package-engine.sh's
    // reconciliation step copies each one into the *other* arch's engine-dist
    // too so both universal-build legs have the same file at the same path
    // (@electron/universal has no whitelist for extraResources files that
    // exist on only one side). That leaves both legs with byte-identical
    // copies of these specific files, which @electron/universal treats as a
    // *different* kind of mismatch ("found a Mach-O file identical across
    // both arches") unless explicitly told that's expected — hence this glob.
    // matchBase (used internally) means these bare filenames match regardless
    // of which directory they live in.
    x64ArchFiles: '{libsndfile_arm64.dylib,libsndfile_x86_64.dylib,libomp.dylib,libiomp5.dylib}',
    // Hardened runtime requires a real Developer ID; with a self-signed or absent
    // certificate it produces a signature macOS rejects at launch. Without a cert
    // electron-builder just *skips* signing (identity: null does too — it does
    // NOT mean "ad hoc" despite how that reads). That leaves the stock Electron
    // binary's original, unmodified signature in place, which Gatekeeper's
    // malware check rejects. So we sign nothing here and instead ad-hoc sign
    // the repackaged app ourselves in `afterPack` below, which is the only
    // reliable way to get a real ad-hoc signature out of electron-builder 24.x.
    identity:           undefined,
    hardenedRuntime:    hasSigningCert,
    gatekeeperAssess:   false,
    entitlements:       'build/entitlements.mac.plist',
    entitlementsInherit:'build/entitlements.mac.plist',
  },

  // electron-builder 24.x does not fall back to ad-hoc signing when no
  // identity is configured — it silently skips signing altogether, leaving
  // the app carrying the raw Electron binary's original signature (which
  // Gatekeeper's malware check flags). Sign it ourselves post-pack instead.
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'darwin' || hasSigningCert) return
    // For a --universal build, electron-builder calls afterPack three times:
    // once for the intermediate x64-only pack, once for the intermediate
    // arm64-only pack (both written to "<appOutDir>-<arch>-temp"), and once
    // for the final merged universal app. @electron/universal diffs the two
    // intermediate apps and requires every non-binary file to be byte-
    // identical before merging them. Ad-hoc signing the intermediates here
    // rewrites nested frameworks' _CodeSignature/CodeResources independently
    // in each pass, so the two copies stop matching and the merge step fails
    // with "Expected all non-binary files to have identical SHAs...". Only
    // sign the final app (single-arch builds have no "-temp" intermediate).
    if (/-(?:x64|arm64|armv7l|ia32)-temp$/.test(context.appOutDir)) {
      console.log(`[afterPack] skipping ad-hoc sign of intermediate universal-build artifact ${context.appOutDir}`)
      return
    }
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    console.log(`[afterPack] ad-hoc signing ${appPath}`)
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  },

  win: {
    // portable = single-exe, no NSIS — safe to build from macOS without Wine.
    // nsis    = traditional installer — requires Wine on macOS; build on Windows or CI.
    target: process.env.WIN_INSTALLER === 'nsis'
      ? [{ target: 'nsis',     arch: ['x64'] }]
      : [{ target: 'portable', arch: ['x64'] }],
    verifyUpdateCodeSignature: false,
    // PyInstaller standalone engine, built by scripts/package-engine.sh with
    // ENGINE_ARCH unset (single x64 output, matching the x64-only target
    // above). See mac.extraResources for why macOS can't share this entry.
    extraResources: [
      {
        from:   'resources/engine-dist',
        to:     'engine-dist',
        filter: ['**/*'],
      },
    ],
  },

  nsis: {
    oneClick:                          false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut:             true,
    createStartMenuShortcut:           true,
    runAfterFinish:                    true,
    perMachine:                        false,
    // preInit macro in this file kills any running instance before NSIS checks file locks.
    include: 'build/installer.nsh',
  },

  linux: {
    target:   ['AppImage', 'deb'],
    category: 'Audio',
    // Same rationale as win.extraResources above.
    extraResources: [
      {
        from:   'resources/engine-dist',
        to:     'engine-dist',
        filter: ['**/*'],
      },
    ],
  },

  // Auto-update via GitHub Releases.
  // Set GITHUB_OWNER / GITHUB_REPO env vars in CI to override.
  publish: [
    {
      provider:    'github',
      owner:       process.env.GITHUB_OWNER  || 'your-org',
      repo:        process.env.GITHUB_REPO   || 'ruanjian',
      releaseType: 'release',
    },
  ],
}

module.exports = config
