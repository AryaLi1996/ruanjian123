/**
 * Auto-update manager using electron-updater.
 *
 * Update server: GitHub Releases (configured via electron-builder publish).
 * Flow: check → notify renderer → user confirms → download → install on quit.
 *
 * In dev mode (app.isPackaged === false) updates are silently skipped.
 */
import { app, BrowserWindow } from 'electron'
import { autoUpdater }        from 'electron-updater'
import log                    from 'electron-log'

autoUpdater.logger = log
log.transports.file.level = 'info'

// Never auto-download — ask the user first
autoUpdater.autoDownload        = false
autoUpdater.autoInstallOnAppQuit = true

type UpdaterEvent =
  | 'updater:checking'
  | 'updater:available'
  | 'updater:not-available'
  | 'updater:progress'
  | 'updater:downloaded'
  | 'updater:error'

// Last event broadcast, if any — lets a freshly-opened Settings page
// (Ticket 37 §2) show the outcome of a check that already ran (e.g. the
// automatic startup check) instead of sitting blank until the user clicks
// "Check for Updates" themselves.
let lastResult: { event: UpdaterEvent; payload?: unknown } | null = null

function send(win: BrowserWindow, event: UpdaterEvent, payload?: unknown): void {
  lastResult = { event, payload }
  if (!win.isDestroyed()) win.webContents.send(event, payload)
}

/** See `lastResult` above. Read via IPC (`updater:get-last-result`). */
export function getLastUpdateResult(): { event: UpdaterEvent; payload?: unknown } | null {
  return lastResult
}

export function setupAutoUpdater(win: BrowserWindow): void {
  if (!app.isPackaged) return   // skip in dev

  // createWindow() calls this again if the app is reactivated on macOS
  // after every window was closed — without this, that second call would
  // stack a fresh set of listeners on top of the old set on this singleton
  // autoUpdater instead of replacing it. The old set still targets the
  // now-destroyed window (send() no-ops on it), so it wasn't a
  // double-broadcast bug, just a leaked closure per reactivation — clearing
  // first keeps it at exactly one live set targeting the current window.
  autoUpdater.removeAllListeners()

  autoUpdater.on('checking-for-update', () => send(win, 'updater:checking'))

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version)
    send(win, 'updater:available', {
      version:     info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    })
  })

  autoUpdater.on('update-not-available', () => send(win, 'updater:not-available'))

  autoUpdater.on('download-progress', (prog) =>
    send(win, 'updater:progress', {
      percent:       Math.round(prog.percent),
      transferred:   prog.transferred,
      total:         prog.total,
      bytesPerSecond: prog.bytesPerSecond,
    })
  )

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info.version)
    send(win, 'updater:downloaded', { version: info.version })
  })

  // Ticket 37 §1: this used to also raise a global notification here via
  // notifyRenderer (notification.system.updateError) — every network hiccup
  // or missing update-server config produced an "Update Check Failed" toast
  // *and* a notification-center entry, which users reported as pure noise
  // since automatic checks run silently in the background. The
  // updater:error event is still broadcast below (TopToolbar clears its
  // "downloading" spinner off it, and SettingsView's Updates section turns
  // it into an inline "Update check failed" message), but nothing calls
  // notify()/notifyRenderer() for it any more.
  autoUpdater.on('error', (err) => {
    log.error('Updater error:', err.message)
    send(win, 'updater:error', { message: err.message })
  })

  // Stagger the check by 3 seconds so it doesn't delay startup. Routed
  // through checkForUpdates() below so the automatic startup check and the
  // manual "Check for Updates" button in Settings (Ticket 37 §2) share one
  // implementation.
  setTimeout(() => checkForUpdates(win), 3_000)
}

/**
 * Runs an update check and broadcasts the result over the same updater:*
 * events setupAutoUpdater() above listens for. Called both by the automatic
 * startup check and, via IPC, by the manual "Check for Updates" button on
 * the Settings page (Ticket 37 §2) — one check implementation, two
 * triggers, neither of which raises a failure notification (Ticket 37 §1).
 */
export function checkForUpdates(win: BrowserWindow): void {
  if (!app.isPackaged) {
    // No update server is configured for dev builds — resolve immediately
    // so a manual check from Settings doesn't spin on "Checking…" forever.
    send(win, 'updater:not-available')
    return
  }
  autoUpdater.checkForUpdates().catch((err) => {
    // The 'error' listener above already logs + broadcasts updater:error
    // for this same failure; this catch exists only to avoid an unhandled
    // promise rejection, not to notify anyone a second time.
    log.error('checkForUpdates failed:', err instanceof Error ? err.message : err)
  })
}

/** Called from IPC when user clicks "Download & Install". */
export function downloadUpdate(): void {
  autoUpdater.downloadUpdate()
}

/** Called from IPC when user clicks "Install now". */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true)
}
