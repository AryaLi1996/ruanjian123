/**
 * Ticket 35 §2/§8: lets main-process code raise a notification without
 * going through a feature-specific IPC channel of its own — e.g. a
 * background event main detects on its own (a renderer crash-recovery, an
 * updater failure) that has no renderer `await` chain waiting on it to
 * hang a `notify()` call off of. The renderer-side flows (training,
 * separation, synthesis, subscription, payment) still call
 * useNotificationStore's `notify()` directly, since those already run
 * inside a renderer promise chain that keeps executing (and can safely call
 * a Zustand action) even after the user has navigated to a different view.
 *
 * Broadcast to every window and fire-and-forget: a destroyed/closing window
 * is skipped rather than throwing, and there is no renderer acknowledgement
 * to wait on, matching Ticket 35 §8's "must not block the main process"
 * requirement.
 */
import { BrowserWindow } from 'electron'

export type MainNotificationCategory = 'taskCompletion' | 'taskFailure' | 'subscription' | 'system' | 'custom'

// Mirrors the renderer's ActiveView (useAppStore.ts) — duplicated rather
// than cross-imported, since src/main and src/renderer/src are separate TS
// projects with disjoint tsconfig `include` globs (see tsconfig.node.json /
// tsconfig.web.json). Every other cross-process shape in this codebase
// follows the same convention (e.g. PersistedModel in global.d.ts vs
// main/model-registry.ts). Keep in sync by hand if either side changes.
export type MainNotificationView = 'training' | 'cover' | 'audio-tools' | 'playback' | 'subscription' | 'settings'

export type MainNotificationAction =
  | { type: 'view'; view: MainNotificationView }
  | { type: 'command'; command: 'download-update' | 'install-update' }

export interface MainNotifyInput {
  category:       MainNotificationCategory
  titleKey:       string
  titleParams?:   Record<string, unknown>
  messageKey?:    string
  messageParams?: Record<string, unknown>
  action?:        MainNotificationAction
}

export const NOTIFICATION_PUSH_CHANNEL = 'notification:push'

export function notifyRenderer(input: MainNotifyInput): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(NOTIFICATION_PUSH_CHANNEL, input)
  }
}
