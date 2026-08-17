import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('engine', {
  call: (method: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('engine:call', method, args),

  onProgress: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on('engine:progress', handler)
    return () => ipcRenderer.removeListener('engine:progress', handler)
  },

  stream: (method: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('engine:stream', method, args),

  saveTrainingFiles: (files: Array<{ name: string; buffer: ArrayBuffer }>): Promise<string> =>
    ipcRenderer.invoke('engine:save-files', files),

  // Read a local file path as ArrayBuffer (used to load stems into Web Audio API)
  readFile: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('fs:read-file', filePath),

  // Save a recorded WAV clip via a native save dialog (Playback/Monitor page)
  saveRecording: (buffer: ArrayBuffer, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('fs:save-recording', buffer, defaultName),

  // Pick a save location for a cover export via a native dialog (Cover Creation → Export panel)
  chooseExportPath: (defaultName: string, extension: string): Promise<string | null> =>
    ipcRenderer.invoke('fs:choose-export-path', defaultName, extension),

  // Online lyrics search (Playback/Monitor page, lrclib.org)
  searchLyrics: (query: { track: string; artist?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('lyrics:search', query),

  // Report renderer crashes caught by the React error boundary
  logRendererError: (payload: unknown): Promise<void> =>
    ipcRenderer.invoke('log:renderer-error', payload),

  // Model encryption / decryption (machine-bound AES-256-GCM)
  encryptModel:     (modelPath: string): Promise<{ encPath: string; sizeBytes: number }> =>
    ipcRenderer.invoke('model:encrypt', modelPath),
  decryptVerify:    (encPath: string): Promise<{ decrypted: boolean; error?: string }> =>
    ipcRenderer.invoke('model:decrypt-verify', encPath),

  // Trained-model library persistence (survives app restart)
  loadModels: (): Promise<unknown[]> => ipcRenderer.invoke('models:load'),
  saveModels: (models: unknown[]): Promise<void> => ipcRenderer.invoke('models:save', models),
  // Best-effort delete, scoped to the engine's own data dir — see index.ts
  deleteDataFile: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:delete-in-data-dir', filePath),

  // First-launch detection
  isFirstLaunch:   (): Promise<boolean> => ipcRenderer.invoke('app:is-first-launch'),
  markInitialized: (): Promise<void>    => ipcRenderer.invoke('app:mark-initialized'),

  // Engine warm-up (shared with main's own startup probe — see index.ts)
  getWarmupResult: (): Promise<{ passed: boolean; ep?: string; elapsedMs?: number; degraded?: boolean; error?: string }> =>
    ipcRenderer.invoke('app:warmup-result'),
  retryWarmup: (): Promise<{ passed: boolean; ep?: string; elapsedMs?: number; degraded?: boolean; error?: string }> =>
    ipcRenderer.invoke('app:warmup-retry'),

  // Auto-updater controls
  updaterDownload:    (): Promise<void> => ipcRenderer.invoke('updater:download'),
  updaterQuitInstall: (): Promise<void> => ipcRenderer.invoke('updater:quit-install'),

  onUpdaterEvent: (cb: (event: string, data: unknown) => void): (() => void) => {
    const events = [
      'updater:checking', 'updater:available', 'updater:not-available',
      'updater:progress', 'updater:downloaded', 'updater:error',
    ] as const
    const handlers = events.map((ev) => {
      const h = (_: Electron.IpcRendererEvent, d: unknown) => cb(ev, d)
      ipcRenderer.on(ev, h)
      return { ev, h }
    })
    return () => handlers.forEach(({ ev, h }) => ipcRenderer.removeListener(ev, h))
  },

  // Subscription / license
  getLicenseState:    ():                    Promise<unknown> => ipcRenderer.invoke('license:get-state'),
  activateLicense:    (key: string):         Promise<unknown> => ipcRenderer.invoke('license:activate', key),
  deactivateLicense:  ():                    Promise<void>    => ipcRenderer.invoke('license:deactivate'),
  refreshLicense:     ():                    Promise<void>    => ipcRenderer.invoke('license:refresh'),
  getLicenseConfig:   ():                    Promise<{ checkoutUrl: string }> => ipcRenderer.invoke('license:get-config'),
  onLicenseStateChange: (cb: (state: unknown) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, s: unknown) => cb(s)
    ipcRenderer.on('license:state-changed', h)
    return () => ipcRenderer.removeListener('license:state-changed', h)
  },
})
