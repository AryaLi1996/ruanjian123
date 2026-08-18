import { app, BrowserWindow, shell, ipcMain, dialog, crashReporter } from 'electron'
import { join, resolve, sep } from 'path'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import { callPythonEngine, callPythonEngineStreaming } from './python-bridge'
import { encryptModelFile, decryptModelFile } from './model-crypto'
import { setupAutoUpdater, downloadUpdate, quitAndInstall } from './auto-updater'
import { SubscriptionMonitor } from './subscription-monitor'
import { LICENSE_CONFIG, usingDefaultSigningSecret } from './license-config'
import { loadModels, saveModels, type PersistedModel } from './model-registry'
import {
  saveBackground, saveBackgroundMeta, loadBackground, loadBackgroundSource, removeBackground,
  type SaveBackgroundPayload, type BackgroundMeta,
} from './background-store'
import log from 'electron-log'
// Collect native crash dumps locally so a renderer/GPU crash leaves a trace.
// Never let telemetry setup stop the app from starting.
try {
  crashReporter.start({ submitURL: 'https://localhost/noop', uploadToServer: false })
} catch {
  /* crash reporting is best-effort */
}
// ── VM / headless compatibility ───────────────────────────────────────────────
// Must be called before app.ready.
// Forces CPU (software) compositing so the GPU process crashing inside a VM
// or on a machine with no DirectX/WebGL support cannot cause a blank window.
app.disableHardwareAcceleration()

if (process.platform === 'win32') {
  // Chromium's sandbox uses job objects that conflict with some hypervisors.
  app.commandLine.appendSwitch('no-sandbox')
  // Fall back to SwANGLE if D3D is unavailable (common in VirtualBox/VMware).
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
}

// ── Single-instance lock ─────────────────────────────────────────────────────
// Quit immediately if another instance is already running; focus that window instead.
// This ensures the NSIS installer (and taskkill) only ever sees one process to close.
const _gotLock = app.requestSingleInstanceLock()
if (!_gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const existing = BrowserWindow.getAllWindows()[0]
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })
}

// ── First-launch marker ───────────────────────────────────────────────────────
function isFirstLaunch(): boolean {
  const marker = join(app.getPath('userData'), '.initialized')
  return !existsSync(marker)
}

function markInitialized(): void {
  const marker = join(app.getPath('userData'), '.initialized')
  fs.writeFile(marker, Date.now().toString()).catch(() => {})
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width:           1200,
    height:          800,
    minWidth:        900,
    minHeight:       600,
    center:          true,    // always on-screen; prevents "only title bar" from off-screen placement
    show:            false,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload script only touches contextBridge/ipcRenderer (no direct
      // Node APIs), so the renderer can run fully sandboxed.
      sandbox:          true,
      // webSecurity disables CORS/same-origin enforcement — normally only
      // acceptable in dev. It's relaxed here ONLY for packaged Windows builds,
      // where type="module" script resolution from file:// can otherwise fail
      // inside the asar. macOS/Linux packaged builds, and all dev builds,
      // keep it on.
      webSecurity:      !(app.isPackaged && process.platform === 'win32'),
      contextIsolation: true,
    },
  })

  // Fallback: show after 5 s if ready-to-show never fires (GPU crash in VM).
  const showFallback = setTimeout(() => { if (!win.isDestroyed()) win.show() }, 5_000)
  win.once('ready-to-show', () => { clearTimeout(showFallback); win.show() })

  // Log renderer failures to the main-process log so they're visible in %AppData%\Ruanjian\logs
  let reloadAttempts = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('[renderer] process gone', details)
    // Recover once; repeated reloads would mask a crash loop.
    if (reloadAttempts < 1 && !win.isDestroyed()) {
      reloadAttempts++
      win.reload()
    }
  })
  win.webContents.on('unresponsive', () => log.error('[renderer] unresponsive'))
  win.webContents.on('did-fail-load', (_e, code, desc) =>
    log.error('[renderer] load failed', code, desc)
  )

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Wire auto-updater to this window
  setupAutoUpdater(win)

  return win
}

interface WarmupResult {
  passed:      boolean
  ep?:         string
  elapsedMs?:  number
  degraded?:   boolean
  error?:      string
}

// Cached so the main-process startup probe and the renderer's warm-up screen
// (App.tsx) share one Python invocation instead of each spawning their own
// test_inference process at launch. `app:warmup-result` below serves this
// same promise to the renderer; `app:warmup-retry` clears it to force a
// fresh run when the user clicks Retry.
let warmupPromise: Promise<WarmupResult> | null = null

function warmUpEngine(): Promise<WarmupResult> {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      const started = Date.now()
      try {
        const result = await callPythonEngine('test_inference', [], 5_000) as {
          passed?: boolean
          ep?: string
          elapsed_ms?: number
          degraded?: boolean
        }
        const out: WarmupResult = {
          passed:    Boolean(result.passed),
          ep:        result.ep,
          elapsedMs: result.elapsed_ms ?? Date.now() - started,
          degraded:  result.degraded ?? false,
        }
        if (out.passed) log.info('[warmup] success', out)
        else             log.warn('[warmup] completed with degraded result', out)
        return out
      } catch (error) {
        log.warn('[warmup] unavailable; continuing with degraded local mode', error)
        return { passed: false, error: String(error) }
      }
    })()
  }
  return warmupPromise
}

// Same "never let startup work block the window forever" pattern as the
// 5s ready-to-show fallback in createWindow(): if a local-disk read stalls
// (synced/virtual filesystem under userData, a permissions prompt, etc.),
// monitor.initialize() can hang indefinitely. Since it's awaited *before*
// createWindow() is even called, a hang here means no window is ever
// created — the app sits in the Dock/Activity Monitor with zero windows
// and the user has to Force Quit it. Race it against a timeout so the
// window always gets created; the monitor keeps running and will settle
// (or the user can hit "Refresh" in the license UI) once whatever was
// blocking it clears.
async function initializeMonitorWithTimeout(ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.error(`[startup] monitor.initialize() did not resolve within ${ms}ms; showing window anyway`)
      resolve()
    }, ms)
  })
  try {
    await Promise.race([monitor.initialize(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

// A packaged build still running with the source-shipped default secret
// means anyone can read that string from this repo and forge a valid
// license token offline. This should never be true for a real release —
// surface it loudly instead of failing silently.
if (app.isPackaged && usingDefaultSigningSecret) {
  log.error(
    '[license] SECURITY: LICENSE_SIGNING_SECRET is not set — this packaged ' +
    'build is using the public template default from license-config.ts. ' +
    'License tokens can be forged offline. Set LICENSE_SIGNING_SECRET (and ' +
    'redeploy the serverless function with the same value) before shipping.',
  )
}

app.whenReady().then(async () => {
  await initializeMonitorWithTimeout(3_000)   // load local license before showing window

  const win = createWindow()
  // Warm-up never gates window creation or UI access.
  void warmUpEngine()

  // Pass first-launch flag to renderer via IPC
  ipcMain.handle('app:is-first-launch', () => isFirstLaunch())
  ipcMain.handle('app:mark-initialized', () => markInitialized())

  // Renderer's warm-up screen reuses this run instead of spawning its own.
  ipcMain.handle('app:warmup-result', () => warmUpEngine())
  ipcMain.handle('app:warmup-retry', () => { warmupPromise = null; return warmUpEngine() })

  // Keeps the native window's paint colour in sync with the renderer's chosen
  // appearance. backgroundColor is only shown momentarily (window creation
  // uses show:false + ready-to-show), but Chromium also repaints it into any
  // gap during resize/maximize compositing — without this a light-appearance
  // user would see a flash of the dark startup default on every resize.
  ipcMain.handle('window:set-background-color', (event, hex: string) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return
    BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(hex)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('engine:call', (_event, method: string, args: unknown[]) =>
  callPythonEngine(method, args)
)

// Streaming handler: emits engine:progress events for each JSON line from Python
ipcMain.handle('engine:stream', (event, method: string, args: unknown[]) =>
  callPythonEngineStreaming(method, args, (data) =>
    event.sender.send('engine:progress', data)
  )
)

// Save uploaded audio files to a per-session training directory
ipcMain.handle(
  'engine:save-files',
  async (_event, files: Array<{ name: string; buffer: ArrayBuffer }>) => {
    const dir = join(app.getPath('userData'), 'training', Date.now().toString())
    await fs.mkdir(dir, { recursive: true })
    for (const { name, buffer } of files) {
      await fs.writeFile(join(dir, name), Buffer.from(buffer))
    }
    return dir
  },
)

// Read a local file as ArrayBuffer so the renderer can load it into Web Audio API
ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
  const buf = await fs.readFile(filePath)
  return buf.buffer
})

// Renderer-side crash/error reports (from the React error boundary)
ipcMain.handle('log:renderer-error', (_event, payload: unknown) => {
  log.error('[renderer] uncaught error', payload)
})

// Reveal a song's source file in the OS file manager (Playback/Monitor song list)
ipcMain.handle('fs:show-in-folder', (_event, filePath: string) => {
  shell.showItemInFolder(filePath)
})

// Online lyrics search (Playback/Monitor page) — proxied through main so the
// renderer's CSP (connect-src 'self') doesn't have to allow third-party hosts.
interface LyricsSearchResult {
  id:            number
  trackName:     string
  artistName:    string
  albumName:     string
  duration:      number | null
  instrumental:  boolean
  syncedLyrics:  string | null
  plainLyrics:   string | null
}

ipcMain.handle(
  'lyrics:search',
  async (_event, query: { track: string; artist?: string }): Promise<LyricsSearchResult[]> => {
    const track = (query?.track ?? '').trim()
    if (!track) return []

    const params = new URLSearchParams({ track_name: track })
    if (query.artist?.trim()) params.set('artist_name', query.artist.trim())

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(`https://lrclib.org/api/search?${params.toString()}`, {
        signal: controller.signal,
        headers: { 'User-Agent': `Ruanjian/${app.getVersion()} (Playback-Monitor lyrics search)` },
      })
      if (!res.ok) throw new Error(`lrclib responded ${res.status}`)
      const data = await res.json()
      if (!Array.isArray(data)) return []
      return data.slice(0, 20).map((r: Record<string, unknown>) => ({
        id:           Number(r.id),
        trackName:    String(r.trackName ?? ''),
        artistName:   String(r.artistName ?? ''),
        albumName:    String(r.albumName ?? ''),
        duration:     typeof r.duration === 'number' ? r.duration : null,
        instrumental: Boolean(r.instrumental),
        syncedLyrics: typeof r.syncedLyrics === 'string' ? r.syncedLyrics : null,
        plainLyrics:  typeof r.plainLyrics === 'string' ? r.plainLyrics : null,
      }))
    } finally {
      clearTimeout(timeout)
    }
  },
)

// Save a recorded WAV clip to a user-selected location (Playback/Monitor page).
ipcMain.handle(
  'fs:save-recording',
  async (_event, buffer: ArrayBuffer, defaultName: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined as never, {
      title: 'Save Recording',
      defaultPath: join(app.getPath('music') || app.getPath('documents'), defaultName),
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    })
    if (canceled || !filePath) return null
    await fs.writeFile(filePath, Buffer.from(buffer))
    return filePath
  },
)

// Let the user pick a save location for a cover export (Cover Creation →
// Export panel). Unlike fs:save-recording above, the file itself is written
// afterward by the Python engine's export_audio (it does the WAV/FLAC/OGG
// encoding), so this only resolves the path — no bytes handled here.
ipcMain.handle(
  'fs:choose-export-path',
  async (_event, defaultName: string, extension: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined as never, {
      title: 'Export Cover',
      defaultPath: join(app.getPath('music') || app.getPath('documents'), defaultName),
      filters: [{ name: `${extension.toUpperCase()} Audio`, extensions: [extension] }],
    })
    if (canceled || !filePath) return null
    return filePath
  },
)

// ── Model encryption IPC ──────────────────────────────────────────────────────

ipcMain.handle('model:encrypt', async (_event, modelPath: string) => {
  const encPath = await encryptModelFile(modelPath)
  const stat    = await fs.stat(encPath)
  return { encPath, sizeBytes: stat.size, encrypted: true }
})

ipcMain.handle('model:decrypt-verify', async (_event, encPath: string) => {
  try {
    const plain = await decryptModelFile(encPath)
    return { decrypted: true, sizeBytes: plain.length }
  } catch (err) {
    return { decrypted: false, error: String(err) }
  }
})

// ── Trained-model library persistence ─────────────────────────────────────────
// See model-registry.ts for why this exists: the renderer's model list was
// in-memory only and lost on every restart.

ipcMain.handle('models:load', () => loadModels())
ipcMain.handle('models:save', (_event, models: PersistedModel[]) => saveModels(models))

// ── Custom background image persistence (Ticket 27/30) ─────────────────────────
// See background-store.ts — durable disk copy backing the renderer's
// localStorage cache, so the feature survives a cleared/full localStorage.
ipcMain.handle('bg:save',        (_event, payload: SaveBackgroundPayload) => saveBackground(payload))
ipcMain.handle('bg:save-meta',   (_event, meta: BackgroundMeta) => saveBackgroundMeta(meta))
ipcMain.handle('bg:load',        () => loadBackground())
ipcMain.handle('bg:load-source', () => loadBackgroundSource())
ipcMain.handle('bg:remove',      () => removeBackground())

// Best-effort cleanup when a model card is deleted. Scoped to the engine's
// own scratch directory so a compromised/buggy renderer can't use this to
// delete arbitrary files elsewhere on disk — it silently no-ops for anything
// outside it (e.g. a model file the user manually relocated).
ipcMain.handle('fs:delete-in-data-dir', async (_event, filePath: string) => {
  const dataDir  = join(app.getPath('userData'), 'engine-data')
  const resolved = resolve(filePath)
  if (resolved !== dataDir && !resolved.startsWith(dataDir + sep)) return false
  try {
    await fs.unlink(resolved)
    return true
  } catch {
    return false
  }
})

// ── Auto-updater IPC ──────────────────────────────────────────────────────────
ipcMain.handle('updater:download',     () => downloadUpdate())
ipcMain.handle('updater:quit-install', () => quitAndInstall())

// ── Subscription / license IPC ────────────────────────────────────────────────
const monitor = SubscriptionMonitor.getInstance()

monitor.on('state-change', (state) => {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('license:state-changed', state)
  })
})

ipcMain.handle('license:get-state',   ()           => monitor.getState())
ipcMain.handle('license:activate',    (_, key: string) => monitor.activate(key))
ipcMain.handle('license:deactivate',  ()           => monitor.deactivate())
ipcMain.handle('license:refresh',     ()           => monitor.refresh())
ipcMain.handle('license:get-config',  () => ({
  checkoutUrl:    LICENSE_CONFIG.checkoutUrl,
  plans:          LICENSE_CONFIG.plans,
  paymentMethods: LICENSE_CONFIG.paymentMethods,
  pollIntervalMs: LICENSE_CONFIG.orderPollIntervalMs,
  pollTimeoutMs:  LICENSE_CONFIG.orderPollTimeoutMs,
}))

// ── Multi-channel payment IPC (Ticket 28) ───────────────────────────────────
ipcMain.handle('payment:create-order', (_, planId: string, method: string) =>
  monitor.createOrder(planId as never, method as never))
ipcMain.handle('payment:order-status', (_, orderId: string) => monitor.getOrderStatus(orderId))
ipcMain.handle('payment:history',      ()                   => monitor.getPaymentHistory())

// Hosted checkout pages for methods whose QR code is rendered by the
// provider/aggregator's own page (WeChat Pay, Douyin Pay) are shown in a
// modal-like child BrowserWindow instead of the system browser, so the QR
// appears inline over the app per Ticket 28 §3. Card/Alipay use the system
// browser instead (see setWindowOpenHandler above) — a clearer trust
// boundary for entering card details or an Alipay login.
let _paymentWin: BrowserWindow | null = null

ipcMain.handle('payment:open-embedded', (event, url: string) => {
  if (_paymentWin && !_paymentWin.isDestroyed()) _paymentWin.close()

  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
  _paymentWin = new BrowserWindow({
    width: 420,
    height: 640,
    parent,
    modal: Boolean(parent),
    show: false,
    title: '',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  _paymentWin.once('ready-to-show', () => _paymentWin?.show())
  _paymentWin.on('closed', () => {
    _paymentWin = null
    if (!event.sender.isDestroyed()) event.sender.send('payment:window-closed')
  })
  // Only ever navigate within the payment provider's own origin(s) — never
  // let this window be redirected somewhere arbitrary by page content.
  _paymentWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  _paymentWin.loadURL(url)
})

ipcMain.handle('payment:close-embedded', () => {
  if (_paymentWin && !_paymentWin.isDestroyed()) _paymentWin.close()
})