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

function send(win: BrowserWindow, event: UpdaterEvent, payload?: unknown): void {
  if (!win.isDestroyed()) win.webContents.send(event, payload)
}

export function setupAutoUpdater(win: BrowserWindow): void {
  if (!app.isPackaged) return   // skip in dev

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

  autoUpdater.on('error', (err) => {
    log.error('Updater error:', err.message)
    send(win, 'updater:error', { message: err.message })
  })

  // Stagger the check by 3 seconds so it doesn't delay startup
  setTimeout(() => autoUpdater.checkForUpdates(), 3_000)
}

/** Called from IPC when user clicks "Download & Install". */
export function downloadUpdate(): void {
  autoUpdater.downloadUpdate()
}

/** Called from IPC when user clicks "Install now". */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true)
}
