/** @type {import('electron-builder').Configuration} */

const path = require('path')
const fs = require('fs')
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
  productName: 'SootheVoice',
  copyright:   'Copyright © 2026',

  directories: { buildResources: 'build', output: 'dist' },

  // SootheVoice / 舒音 brand mark (Ticket 32 §7) — full logo, dark
  // rounded-square background, generated from src/assets/brand/logo-full.svg.
  // build/icon.icns is provided directly (built via iconutil from a proper
  // .iconset so macOS gets a native, non-resampled icon at every size);
  // build/icon.png is the single 1024x1024 source electron-builder derives
  // the Windows .ico from at build time (linux also falls back to it). Set
  // per-platform below rather than as a shared top-level `icon` since mac
  // needs the .icns specifically while win/linux want the source .png.

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
    icon:               'build/icon.icns',
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
    // Declares which locales the app actually ships display-name overrides
    // for (afterPack below writes the matching <lang>.lproj/InfoPlist.strings
    // files) — Ticket 40 §6. Info.plist itself only has one top-level
    // CFBundleDisplayName ("SootheVoice", from productName above); this is
    // what lets macOS show "舒音" instead for zh_CN system-language users.
    extendInfo: {
      CFBundleLocalizations: ['en', 'zh_CN'],
    },
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

    // Ticket 40 §6: CFBundleDisplayName in the top-level Info.plist
    // (electron-builder sets it from productName, "SootheVoice") is a single
    // fixed string — Info.plist has no per-locale variants of its own. macOS
    // *does* support localizing it via a `<lang>.lproj/InfoPlist.strings`
    // override placed next to Info.plist: when present for the user's active
    // system language, its CFBundleDisplayName wins over the top-level one
    // for Dock/Finder/menu-bar display, matching mac.extendInfo's
    // CFBundleLocalizations above. Written here — before signing below —
    // since adding files to an already-signed bundle invalidates its
    // signature; this ordering is what makes that safe.
    //
    // NOTE: this only runs in the ad-hoc path (this whole function returns
    // early above when hasSigningCert is true). If real Developer ID signing
    // is wired up later, whatever does that signing needs to run *after*
    // this step too, or the signed app will be missing these overrides.
    const resourcesDir = path.join(appPath, 'Contents', 'Resources')
    const localizedDisplayNames = { en: 'SootheVoice', zh_CN: '舒音' }
    for (const [lang, displayName] of Object.entries(localizedDisplayNames)) {
      const lprojDir = path.join(resourcesDir, `${lang}.lproj`)
      fs.mkdirSync(lprojDir, { recursive: true })
      fs.writeFileSync(path.join(lprojDir, 'InfoPlist.strings'), `CFBundleDisplayName = "${displayName}";\n`, 'utf8')
    }
    console.log(`[afterPack] wrote localized CFBundleDisplayName for: ${Object.keys(localizedDisplayNames).join(', ')}`)

    console.log(`[afterPack] ad-hoc signing ${appPath}`)
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  },

  win: {
    // portable = single-exe, no NSIS — safe to build from macOS without Wine.
    // nsis    = traditional installer — requires Wine on macOS; build on Windows or CI.
    target: process.env.WIN_INSTALLER === 'nsis'
      ? [{ target: 'nsis',     arch: ['x64'] }]
      : [{ target: 'portable', arch: ['x64'] }],
    icon:                       'build/icon.png',
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
    // Diagnostic escape hatch for build-windows-nsis.yml (Ticket 40 CI): a
    // silent install's finish page auto-launches the freshly installed app
    // even with no UI, and on the CI runner's headless/already-elevated
    // session that has been crashing the installer itself (exit code
    // -1073741819 / 0xC0000005 STATUS_ACCESS_VIOLATION) before it gets as
    // far as creating the Start Menu shortcut this workflow checks for.
    // CI_NSIS_NO_RUN, set only by that workflow, isolates whether the crash
    // is in the post-install auto-launch path or earlier in the install
    // itself — real users' installers are unaffected (env var unset).
    runAfterFinish:                    process.env.CI_NSIS_NO_RUN !== 'true',
    perMachine:                        false,
    // preInit macro in this file kills any running instance before NSIS checks file locks.
    include: 'build/installer.nsh',
  },

  linux: {
    target:   ['AppImage', 'deb'],
    icon:     'build/icon.png',
    category: 'Audio',
    // Unlike mac/win, electron-builder's Linux target does NOT default this
    // from productName — it defaults to package.json's bare `name` field,
    // "ruanjian" — confirmed directly in a real CI build's logged
    // configuration (Ticket 40 follow-up): the generated .desktop entry came
    // out with `Icon=ruanjian` and `"executableName":"ruanjian"` even though
    // productName is "SootheVoice" everywhere else. Set explicitly so the
    // installed binary and the .desktop file's Icon= key (which must match
    // an actually-installed icon name to resolve) both say SootheVoice.
    executableName: 'SootheVoice',
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
