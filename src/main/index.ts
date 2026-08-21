import { app, BrowserWindow, shell, ipcMain, dialog, crashReporter, Menu } from 'electron'
import { join, resolve, sep, dirname } from 'path'
import { existsSync, renameSync } from 'fs'
import { promises as fs } from 'fs'
import { callPythonEngine, callPythonEngineStreaming } from './python-bridge'
import { encryptModelFile, decryptModelFile } from './model-crypto'
import { setupAutoUpdater, checkForUpdates, getLastUpdateResult, downloadUpdate, quitAndInstall } from './auto-updater'
import { SubscriptionMonitor } from './subscription-monitor'
import { LICENSE_CONFIG, usingDefaultSigningSecret } from './license-config'
import { loadModels, saveModels, type PersistedModel } from './model-registry'
import { loadLyricsCache, saveLyricsCache, type LyricsCache } from './lyrics-cache'
import { searchLibrary, fetchLibraryAudio, type LibrarySong } from './library'
import {
  saveBackground, saveBackgroundMeta, loadBackground, loadBackgroundSource, removeBackground,
  type SaveBackgroundPayload, type BackgroundMeta,
} from './background-store'
import { notifyRenderer } from './notification-bridge'
import { createSplashWindow, closeSplashWindow } from './splash'
import { migrateUserData } from './user-data-migration'
import log from 'electron-log'

// ── App identity fix + userData migration (Ticket 40) ───────────────────────
// Electron's default userData path is "<app data dir>/<app.getName()>".
// app.getName() is *supposed* to read package.json's `productName` (falling
// back to `name`) per Electron's own docs — but electron-builder strips
// `productName` out of the package.json it actually bundles into app.asar
// (confirmed by extracting a packaged build), leaving only `name`. So even
// with electron-builder.js's `productName: 'SootheVoice'` (which is real and
// correctly drives the Dock/Finder/menu-bar name via Info.plist — Ticket 32)
// and this ticket's package.json `productName` addition (which only reaches
// dev/unpackaged runs), every *packaged* build's app.getName() has still
// quietly resolved to the old placeholder, "ruanjian" — and so has its
// userData path. app.setName() is the one mechanism that reliably overrides
// this in every run mode, packaged or not; it's used here for the first time
// specifically because it's now paired with the migration below, which is
// what makes it safe — flipping the userData path without one would silently
// orphan every existing install's license, trial state, saved models, and
// training data behind an empty new profile.
app.setName('SootheVoice')

// Set below if the migration fails, and surfaced to the user once a window
// can actually show a dialog (see the app.whenReady() handler) — this runs
// far too early in startup for BrowserWindow-based UI (notifyRenderer would
// be a silent no-op here; there is no window yet). A failure here previously
// only went to electron-log, a file the user would never open — meaning
// their license/trial/models could appear to have vanished with no
// explanation. The old directory is never touched on failure (see
// user-data-migration.ts), so this is purely about making that recoverable
// state visible instead of silent.
let userDataMigrationFailure: { oldDir: string; newDir: string } | null = null

function runUserDataMigration(): void {
  // Deliberately NOT app.getPath('userData') here: Electron materializes
  // (mkdir -p's) that directory as a side effect of computing it, which
  // would make it "already exist" by the time we checked — a genuine bug hit
  // while testing this fix, where the migration silently no-op'd because the
  // very act of asking for the new path had just created it empty. Building
  // the same default path ourselves from 'appData' + the app name avoids
  // touching the filesystem before the migration decision is made.
  const newDir = join(app.getPath('appData'), app.getName())
  const oldDir = join(app.getPath('appData'), 'ruanjian')
  const outcome = migrateUserData(oldDir, newDir, { exists: existsSync, rename: renameSync, join })
  if (outcome.status === 'migrated') {
    log.info(`[migrate] moved userData "${oldDir}" -> "${newDir}"`)
  } else if (outcome.status === 'failed') {
    log.error('[migrate] failed to move userData dir', outcome.error)
    userDataMigrationFailure = { oldDir, newDir }
  }
}
runUserDataMigration()

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

// Set once the main window is created (see app.whenReady() below) so
// second-instance can target it directly instead of guessing from window
// creation order — with the splash window (Ticket 38) now created first,
// BrowserWindow.getAllWindows()[0] would resolve to the splash, not the
// app, for as long as the splash is on screen.
let mainWindow: BrowserWindow | null = null

// ── Single-instance lock ─────────────────────────────────────────────────────
// Quit immediately if another instance is already running; focus that window instead.
// This ensures the NSIS installer (and taskkill) only ever sees one process to close.
const _gotLock = app.requestSingleInstanceLock()
if (!_gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const existing = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows()[0]
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })
}

// ── Windows runtime DLL preflight (Ticket 41) ───────────────────────────────
// Electron's own Chromium distribution ships a handful of native DLLs next
// to the packaged .exe — ffmpeg.dll (media decode) among them — which this
// app never asks for directly: there is no ffmpeg-static/fluent-ffmpeg/
// imageio-ffmpeg anywhere in package.json, and the Python engine only uses
// `soundfile` (libsndfile) for audio I/O, never ffmpeg/pydub/librosa/
// audioread. So "ffmpeg.dll not found" on Windows means the Electron
// runtime itself shipped incomplete — most commonly antivirus quarantining
// it out of the installed/extracted app directory (a well-known false
// positive on ffmpeg.dll) or a corrupted install/extraction — not a missing
// dependency this app's own code controls.
//
// If ffmpeg.dll is a hard load-time import of the main executable, the
// Windows loader fails before this file ever runs and no amount of JS can
// intercept it — scripts/verify-win-package.mjs guards against *shipping*
// that build in the first place. But since some of Chromium's media
// pipeline only touches ffmpeg.dll lazily (first audio/video decode), a
// half-broken install can still reach this point; catch that case here with
// a clear, actionable dialog instead of a silent failure deeper in the app.
function findMissingWindowsRuntimeDlls(): string[] {
  if (process.platform !== 'win32' || !app.isPackaged) return []
  const runtimeDir = dirname(process.execPath)
  return ['ffmpeg.dll'].filter((name) => !existsSync(join(runtimeDir, name)))
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

// macOS's auto-generated default menu (used whenever nobody calls
// Menu.setApplicationMenu) hard-codes app.getName() into its labels —
// "About ruanjian", "Hide ruanjian", "Quit ruanjian" — which used to keep
// showing the old placeholder even after the SootheVoice rebrand (Ticket 32)
// and the app.setName() fix above (Ticket 40), because at the time this was
// written that call didn't exist yet (see the comment above it for why).
// Now that app.setName('SootheVoice') runs at startup, app.getName() itself
// is correct — but this explicit template is left in place as a
// belt-and-suspenders: it hardcodes the label directly rather than
// depending on app.getName() staying right in the future. Scoped to darwin
// only: Windows/Linux keep Electron's existing default menu untouched.
function setupAppMenu(): void {
  if (process.platform !== 'darwin') return
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'SootheVoice',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.setAboutPanelOptions({
    applicationName:    'SootheVoice',
    applicationVersion: app.getVersion(),
    copyright:          'Copyright © 2026',
  })
}

// onFirstShow fires exactly once, the first time this window actually becomes
// visible (either via 'ready-to-show' or the 5s fallback below) — used by
// app.whenReady() to close the splash window at the right moment instead of
// on a fixed timer of its own.
function createWindow(onFirstShow?: () => void): BrowserWindow {
  let shown = false
  const fireFirstShow = (): void => {
    if (shown) return
    shown = true
    onFirstShow?.()
  }

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
  // This is also the hard upper bound on how long the splash window (Ticket
  // 38) stays on screen — whatever is slow, the user sees *some* window
  // within 5s rather than a frozen splash.
  const showFallback = setTimeout(() => { if (!win.isDestroyed()) win.show(); fireFirstShow() }, 5_000)
  win.once('ready-to-show', () => { clearTimeout(showFallback); win.show(); fireFirstShow() })

  // Log renderer failures to the main-process log so they're visible in %AppData%\SootheVoice\logs
  let reloadAttempts = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('[renderer] process gone', details)
    // Recover once; repeated reloads would mask a crash loop.
    if (reloadAttempts < 1 && !win.isDestroyed()) {
      reloadAttempts++
      win.reload()
      // The other genuine "main process only" case for notification-bridge.ts:
      // the renderer just crashed, so there is no live promise chain (and no
      // mounted useNotificationStore) to have called notify() itself — by
      // definition nothing in the old renderer survives this event. Waits for
      // the reloaded page to actually finish loading (rather than sending
      // immediately, into a webContents with no document yet) before pushing.
      win.webContents.once('did-finish-load', () => {
        notifyRenderer({
          category: 'system',
          titleKey: 'notification.system.rendererRecovered.title',
          messageKey: 'notification.system.rendererRecovered.message',
        })
      })
    }
  })
  win.webContents.on('unresponsive', () => log.error('[renderer] unresponsive'))
  // A failed initial load (as opposed to a later crash, handled above) would
  // otherwise leave the user staring at a blank window forever with no
  // window-shown event ever firing to reveal why. Surface it instead of
  // silently sitting there — the 5s fallback above still guarantees *a*
  // window appears, but this tells the user (and the log) what happened.
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // ERR_ABORTED (-3) fires for routine, non-error navigation cancellations —
    // most commonly the window itself closing mid-load (e.g. app quit during
    // startup) — not an actual load failure. Treating it as one would pop a
    // spurious "failed to start" dialog during ordinary shutdown.
    if (code === -3) return
    log.error('[renderer] load failed', code, desc, url)
    if (isMainFrame && !win.isDestroyed()) {
      dialog.showErrorBox(
        'SootheVoice failed to start',
        `The app UI could not be loaded (${desc || code}). Please reinstall the app or contact support if this persists.`,
      )
    }
  })

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

// test_inference's own matmul run is sub-millisecond (see engine/inference.py)
// — nearly the entire wall-clock cost here is spawning the process itself:
// unpacking the PyInstaller bundle, `import onnxruntime`, and initializing
// the execution provider. On Windows that provider is usually DirectML,
// whose first-ever session init compiles/caches shaders and can easily run
// several seconds; a freshly-written, unsigned .exe can also get held up by
// Windows Defender scanning it before it's even allowed to run. This is the
// *coldest* engine invocation of the app's lifetime, so it needs at least as
// much budget as every other callPythonEngine() call gets by default — a
// tighter timeout here just turns a slow-but-healthy machine into a bogus
// "warm-up failed" on every launch.
const WARMUP_TIMEOUT_MS = 30_000

function warmUpEngine(): Promise<WarmupResult> {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      const started = Date.now()
      try {
        const result = await callPythonEngine('test_inference', [], WARMUP_TIMEOUT_MS) as {
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

app.whenReady().then(() => {
  // Ticket 41: bail out with a clear, actionable dialog rather than letting
  // the app limp forward into a broken/blank window (or a later, more
  // confusing crash the first time something tries to decode audio).
  const missingDlls = findMissingWindowsRuntimeDlls()
  if (missingDlls.length > 0) {
    log.error(`[startup] missing Windows runtime file(s) next to executable: ${missingDlls.join(', ')}`)
    dialog.showErrorBox(
      '启动失败 / Failed to Start',
      `应用缺少必要的运行库文件（${missingDlls.join('、')}），安装包可能已损坏，或被杀毒软件拦截/删除。` +
      '请临时关闭杀毒软件后重新下载并安装应用。\n\n' +
      `Missing required runtime file(s): ${missingDlls.join(', ')}. This usually means the installer ` +
      'was corrupted, or antivirus software quarantined a file during install/extraction. Please ' +
      'temporarily disable your antivirus, then re-download and reinstall the application.',
    )
    app.quit()
    return
  }

  // Ticket 40 follow-up: the rebrand's userData migration (see
  // runUserDataMigration() above) failed for this user — unlike the DLL
  // check above, this is never fatal (the app still starts up fine under an
  // empty profile), so this is an informational, non-blocking notice rather
  // than an app.quit(). The old directory itself was never touched by a
  // failed migration attempt, so pointing at it is a real, safe recovery
  // path rather than just an apology.
  if (userDataMigrationFailure) {
    const { oldDir, newDir } = userDataMigrationFailure
    dialog.showMessageBox({
      type:    'warning',
      title:   '数据未能自动迁移 / Data Not Automatically Migrated',
      message: '未能自动迁移你的历史数据 / Could not automatically migrate your existing data',
      detail:
        `舒音已更名，但未能自动迁移你的许可证、模型与训练数据。你的原始数据仍完好保存在：\n${oldDir}\n\n` +
        `应用现在使用一个新的空白数据目录：\n${newDir}\n\n` +
        '如需恢复，请退出应用，将上方旧目录中的文件手动移动到新目录，然后重新启动。\n\n' +
        `SootheVoice was renamed, but couldn't automatically move your license, models, and training ` +
        `data. Your original data is still intact at:\n${oldDir}\n\n` +
        `The app is now using a fresh, empty data directory:\n${newDir}\n\n` +
        'To recover it, quit the app, manually move the files from the old directory above into the ' +
        'new one, then relaunch.',
    }).catch(() => { /* best-effort — a failed dialog must not block startup */ })
  }

  // Shown synchronously, before any of the async work below even starts —
  // this is the user's very first feedback that launch is in progress
  // (Ticket 38). It has no dependency on the renderer bundle, IPC, or
  // userData/network state, so it paints immediately regardless of how long
  // anything else takes.
  const splash = createSplashWindow()

  setupAppMenu()
  // Main window starts loading its renderer immediately, in parallel with
  // license/trial state below — it no longer waits on that network-bound
  // work to even begin. The splash window covers the gap either way, and is
  // closed the moment this window is first shown (ready-to-show, or the 5s
  // fallback inside createWindow — see there for why that bound exists).
  const win = createWindow(() => closeSplashWindow(splash))
  mainWindow = win
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  // Warm-up never gates window creation or UI access.
  void warmUpEngine()
  // License/trial state also never gates window creation or UI access — the
  // renderer already reacts to it asynchronously via the 'state-change' →
  // 'license:state-changed' IPC push (see monitor.on('state-change', ...)
  // below), so there's nothing to await here before creating the window.
  void initializeMonitorWithTimeout(3_000)

  // Pass first-launch flag to renderer via IPC
  ipcMain.handle('app:is-first-launch', () => isFirstLaunch())
  ipcMain.handle('app:mark-initialized', () => markInitialized())

  // App version, for the About page (Ticket 32)
  ipcMain.handle('app:get-version', () => app.getVersion())

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
    if (BrowserWindow.getAllWindows().length === 0) {
      const reopened = createWindow()
      mainWindow = reopened
      reopened.on('closed', () => { if (mainWindow === reopened) mainWindow = null })
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Ticket 44: exporting a full mixdown (FLAC/OGG encoding of a real song, on
// a slower machine) can legitimately take longer than the 30s budget every
// other engine:call gets by default — give it its own, more generous
// ceiling instead of timing out an export that's simply still working.
const EXPORT_TIMEOUT_MS = 5 * 60_000

ipcMain.handle('engine:call', (_event, method: string, args: unknown[]) =>
  callPythonEngine(method, args, method === 'export_audio' ? EXPORT_TIMEOUT_MS : undefined)
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
        headers: { 'User-Agent': `SootheVoice/${app.getVersion()} (Playback-Monitor lyrics search)` },
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

// ── Cloud Library (云曲库) search + audio caching (Ticket 18) ──────────────
// See library.ts — search proxies through main for the same CSP reason as
// lyrics:search above; fetch-audio downloads (or reuses a cached copy of)
// the selected song's full audio so Cover Creation has a local file to feed
// into separation as the "目标音频".
ipcMain.handle(
  'library:search',
  (_event, keyword: string, page?: number, pageSize?: number) => searchLibrary(keyword, page, pageSize),
)
ipcMain.handle(
  'library:fetch-audio',
  (_event, song: LibrarySong) => fetchLibraryAudio(song),
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

// ── Automatic lyrics-match cache (Ticket 43 §4) ─────────────────────────────
// See lyrics-cache.ts — durable so a song matched once doesn't re-query
// lrclib.org on every subsequent load.
ipcMain.handle('lyrics:cache-load', () => loadLyricsCache())
ipcMain.handle('lyrics:cache-save', (_event, cache: LyricsCache) => saveLyricsCache(cache))

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
// Manual "Check for Updates" button in Settings (Ticket 37 §2) — reuses the
// exact same electron-updater check the startup timer runs, broadcasting
// results over the usual updater:* events rather than a dedicated reply, so
// SettingsView listens the same way TopToolbar already does.
ipcMain.handle('updater:check', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) checkForUpdates(win)
})
// Lets SettingsView show the outcome of a check that already ran (the
// startup timer, or an earlier manual click) instead of sitting blank
// until the user clicks "Check for Updates" again.
ipcMain.handle('updater:get-last-result', () => getLastUpdateResult())

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

// Ticket 34: server-computed plan pricing — see getPlans() doc.
ipcMain.handle('payment:get-plans',    ()                   => monitor.getPlans())

// ── Multi-channel payment IPC (Ticket 28) ───────────────────────────────────
ipcMain.handle('payment:create-order', (_, planId: string, method: string) =>
  monitor.createOrder(planId as never, method as never))
ipcMain.handle('payment:order-status', (_, orderId: string) => monitor.getOrderStatus(orderId))
ipcMain.handle('payment:history',      ()                   => monitor.getPaymentHistory())
// Ticket 31: live, server-computed availability — see getPaymentMethods() doc.
ipcMain.handle('payment:get-methods',  (_, lang: string)    => monitor.getPaymentMethods(lang))

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