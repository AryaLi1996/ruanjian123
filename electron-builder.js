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
    // PyInstaller standalone engine (built by scripts/package-engine.sh).
    // Absent in dev — python-bridge falls back to system python3.
    {
      from:   'resources/engine-dist',
      to:     'engine-dist',
      filter: ['**/*'],
    },
  ],

  mac: {
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    category:           'public.app-category.productivity',
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
