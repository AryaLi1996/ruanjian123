import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Separate from electron.vite.config.ts (which builds the actual app) —
// Vitest only needs the renderer's React/JSX handling and jsdom globals
// (localStorage, crypto.randomUUID) that the notification store relies on;
// it never touches the main/preload build.
//
// src/main is also included (Ticket 40 follow-up): jsdom is a superset
// environment, so plain Node-side unit tests with no Electron/fs
// dependencies of their own (see user-data-migration.test.ts, which takes
// its fs access via injected deps rather than touching a real filesystem
// or importing 'electron') run fine under it too — no second Vitest project
// needed just for the one main-process test file so far.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': '/src/renderer/src',
    },
  },
  test: {
    environment: 'jsdom',
    include: [
      'src/renderer/src/**/*.test.{ts,tsx}',
      'src/main/**/*.test.ts',
    ],
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
  },
})
