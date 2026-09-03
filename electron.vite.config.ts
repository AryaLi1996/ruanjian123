import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // electron-updater and electron-log must be bundled, not externalized —
    // they are not resolvable from inside the packaged asar at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ['electron-updater', 'electron-log'] })],

    // Licence configuration has to be substituted at build time, because
    // process.env in the main bundle is read on the *end user's* machine at
    // launch, where none of it is set. Without this, a release job handed
    // LICENSE_SIGNING_SECRET passed it nowhere: every packaged build verified
    // licences with the public default in license-config.ts.
    //
    // Each name is replaced only when the build actually has a value, so an
    // unconfigured build keeps the `process.env['…'] ?? DEFAULT` expression
    // intact and behaves exactly as it does today — public default, and the
    // startup warning that says so. Replacing with `undefined` instead would
    // work equally well for the ?? fallbacks, but leaving the lookup alone
    // keeps `npm run dev` reading a real environment.
    define: Object.fromEntries(
      [
        'LICENSE_SIGNING_SECRET',
        'PREVIOUS_LICENSE_SIGNING_SECRET',
        'LICENSE_URL',
        'APP_ID',
        'VITE_APP_ID',
      ]
        .filter((name) => (process.env[name] ?? '').trim() !== '')
        .map((name) => [`process.env['${name}']`, JSON.stringify(process.env[name]!.trim())]),
    )
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
