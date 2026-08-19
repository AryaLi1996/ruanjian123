import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Separate from electron.vite.config.ts (which builds the actual app) —
// Vitest only needs the renderer's React/JSX handling and jsdom globals
// (localStorage, crypto.randomUUID) that the notification store relies on;
// it never touches the main/preload build.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': '/src/renderer/src',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/renderer/src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
  },
})
