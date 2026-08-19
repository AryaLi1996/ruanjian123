// Node 22+ ships its own global `localStorage` (file-backed, behind
// --experimental-webstorage) which competes with jsdom's window.localStorage
// for the bare `localStorage` identifier under Vitest — and without a
// `--localstorage-file` configured, Node's version is a broken stub whose
// methods (clear(), etc.) throw. Rather than relying on a Node CLI flag
// (`--no-experimental-webstorage`, unportable across the OSes this app
// targets — see electron-builder.js's win/mac/linux targets — and easy to
// forget when running `vitest` directly instead of through the npm script),
// install a small in-memory localStorage of our own before any test runs.
// It only needs to satisfy what this codebase's stores actually call:
// getItem/setItem/removeItem — see useSettingsStore.ts's
// readPersisted/persist and useNotificationStore.ts's readJson/writeJson.
class MemoryStorage implements Storage {
  private store = new Map<string, string>()

  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null }
  setItem(key: string, value: string): void { this.store.set(key, String(value)) }
  removeItem(key: string): void { this.store.delete(key) }
  clear(): void { this.store.clear() }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null }
  get length(): number { return this.store.size }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
})
