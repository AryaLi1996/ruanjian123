import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Separate from electron.vite.config.ts (which builds the actual app) —
// Vitest only needs the renderer's React/JSX handling and jsdom globals
// (localStorage, crypto.randomUUID) that the notification store relies on;
// it never touches the main/preload build.
//
// src/main is also included: jsdom is a superset environment, so plain
// Node-side unit tests run fine under it too — no second Vitest project
// needed just for a couple of main-process test files. Only works for
// main-process modules written with zero `electron` dependency of their own
// (e.g. user-data-migration.ts, trial-duration.ts, both testable via
// injected deps) — most of src/main/ imports `electron`, which isn't a real
// module outside an actual Electron process, so it can't be exercised here.
// Keep main-process code meant to be unit tested this way in small
// electron-free files like those, with the electron-touching orchestration
// layered on top.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': '/src/renderer/src',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/renderer/src/**/*.test.{ts,tsx}', 'src/main/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
  },
})
