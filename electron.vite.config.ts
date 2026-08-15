import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // electron-updater and electron-log must be bundled, not externalized —
    // they are not resolvable from inside the packaged asar at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ['electron-updater', 'electron-log'] })]
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
