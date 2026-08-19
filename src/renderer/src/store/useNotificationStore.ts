import { create } from 'zustand'
import type { ActiveView } from './useAppStore'

// ── Types ─────────────────────────────────────────────────────────────────────

export type NotificationCategory = 'taskCompletion' | 'taskFailure' | 'subscription' | 'system' | 'custom'
export type ToastPosition = 'top-right' | 'bottom-right'

// Actions a toast/history item can carry — kept as a small closed set
// (rather than an arbitrary actionUrl, per the ticket's `actionUrl?`) since
// everything this app currently needs to do on click is either "switch to
// this view" or "run one of two updater commands" (Ticket 35 §5).
export type NotificationAction =
  | { type: 'view'; view: ActiveView }
  | { type: 'command'; command: 'download-update' | 'install-update' }

export interface NotificationRecord {
  id:            string
  category:      NotificationCategory
  icon:          string
  // Title/message are stored as i18n keys + interpolation params (not
  // pre-rendered strings) so history re-renders correctly if the user
  // switches language after a notification already landed (Ticket 35 §7/§9).
  titleKey:      string
  titleParams?:  Record<string, unknown>
  messageKey?:   string
  messageParams?: Record<string, unknown>
  action?:       NotificationAction
  createdAt:     number
  read:          boolean
}

export interface NotifyInput {
  category:      NotificationCategory
  icon?:         string
  titleKey:      string
  titleParams?:  Record<string, unknown>
  messageKey?:   string
  messageParams?: Record<string, unknown>
  action?:       NotificationAction
}

export interface NotificationPreferences {
  categoriesEnabled: Record<NotificationCategory, boolean>
  toastDurationSec:  number // 3–10, see TOAST_DURATION_MIN/MAX
  position:          ToastPosition
}

const DEFAULT_ICON: Record<NotificationCategory, string> = {
  taskCompletion: '✓',
  taskFailure:    '⚠',
  subscription:   '💎',
  system:         'ℹ️',
  custom:         '🔔',
}

export const TOAST_DURATION_MIN = 3
export const TOAST_DURATION_MAX = 10
const DEFAULT_TOAST_DURATION = 5
const DEFAULT_POSITION: ToastPosition = 'top-right'

export const MAX_VISIBLE_TOASTS = 3
export const MAX_HISTORY = 100
// A burst of simultaneous events (rare, but e.g. an update check landing the
// same tick as a subscription sync) shouldn't be able to grow the waiting
// queue without bound — oldest waiting toasts are dropped first; they're
// still in history, just not queued for a toast of their own.
const MAX_QUEUED_TOASTS = 10

const HISTORY_KEY = 'ruanjian.notifications.history'
const PREFS_KEY   = 'ruanjian.notifications.prefs'

const DEFAULT_PREFERENCES: NotificationPreferences = {
  categoriesEnabled: {
    taskCompletion: true,
    taskFailure:    true,
    subscription:   true,
    system:         true,
    custom:         true,
  },
  toastDurationSec: DEFAULT_TOAST_DURATION,
  position:         DEFAULT_POSITION,
}

// Same best-effort localStorage pattern as useSettingsStore — a private
// browsing profile or full quota shouldn't stop notifications from working
// for the rest of the session, just from surviving a restart.
function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* best-effort */
  }
}

function loadPreferences(): NotificationPreferences {
  const saved = readJson<Partial<NotificationPreferences>>(PREFS_KEY)
  if (!saved) return DEFAULT_PREFERENCES
  const duration = Number(saved.toastDurationSec)
  return {
    categoriesEnabled: { ...DEFAULT_PREFERENCES.categoriesEnabled, ...saved.categoriesEnabled },
    toastDurationSec: Number.isFinite(duration) && duration >= TOAST_DURATION_MIN && duration <= TOAST_DURATION_MAX
      ? duration
      : DEFAULT_TOAST_DURATION,
    position: saved.position === 'bottom-right' ? 'bottom-right' : DEFAULT_POSITION,
  }
}

function loadHistory(): NotificationRecord[] {
  const saved = readJson<NotificationRecord[]>(HISTORY_KEY)
  return Array.isArray(saved) ? saved.slice(0, MAX_HISTORY) : []
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface NotificationState {
  history:       NotificationRecord[]
  activeToasts:  NotificationRecord[] // currently visible, max MAX_VISIBLE_TOASTS
  toastQueue:    NotificationRecord[] // waiting their turn
  preferences:   NotificationPreferences

  notify:            (input: NotifyInput) => void
  dismissToast:      (id: string) => void
  markRead:          (id: string) => void
  markAllRead:       () => void
  removeHistoryItem: (id: string) => void
  clearHistory:      () => void
  setPreferences:    (patch: Partial<NotificationPreferences>) => void
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  history:      loadHistory(),
  activeToasts: [],
  toastQueue:   [],
  preferences:  loadPreferences(),

  notify: (input) => {
    const { preferences } = get()
    // A disabled category is suppressed entirely — no toast, no history
    // entry — per Ticket 35 §6 ("enable/disable specific categories").
    if (!preferences.categoriesEnabled[input.category]) return

    const record: NotificationRecord = {
      id:            crypto.randomUUID(),
      category:      input.category,
      icon:          input.icon ?? DEFAULT_ICON[input.category],
      titleKey:      input.titleKey,
      titleParams:   input.titleParams,
      messageKey:    input.messageKey,
      messageParams: input.messageParams,
      action:        input.action,
      createdAt:     Date.now(),
      read:          false,
    }

    set((s) => {
      const history = [record, ...s.history].slice(0, MAX_HISTORY)
      writeJson(HISTORY_KEY, history)

      const hasRoom = s.activeToasts.length < MAX_VISIBLE_TOASTS
      return {
        history,
        activeToasts: hasRoom ? [...s.activeToasts, record] : s.activeToasts,
        toastQueue:   hasRoom ? s.toastQueue : [...s.toastQueue, record].slice(-MAX_QUEUED_TOASTS),
      }
    })
  },

  dismissToast: (id) => set((s) => {
    const activeToasts = s.activeToasts.filter((toast) => toast.id !== id)
    if (s.toastQueue.length > 0 && activeToasts.length < MAX_VISIBLE_TOASTS) {
      const [next, ...rest] = s.toastQueue
      return { activeToasts: [...activeToasts, next], toastQueue: rest }
    }
    return { activeToasts }
  }),

  markRead: (id) => set((s) => {
    const history = s.history.map((item) => item.id === id ? { ...item, read: true } : item)
    writeJson(HISTORY_KEY, history)
    return { history }
  }),

  markAllRead: () => set((s) => {
    const history = s.history.map((item) => item.read ? item : { ...item, read: true })
    writeJson(HISTORY_KEY, history)
    return { history }
  }),

  removeHistoryItem: (id) => set((s) => {
    const history = s.history.filter((item) => item.id !== id)
    writeJson(HISTORY_KEY, history)
    return { history }
  }),

  clearHistory: () => {
    writeJson(HISTORY_KEY, [])
    set({ history: [] })
  },

  setPreferences: (patch) => set((s) => {
    const preferences: NotificationPreferences = {
      ...s.preferences,
      ...patch,
      categoriesEnabled: { ...s.preferences.categoriesEnabled, ...patch.categoriesEnabled },
    }
    writeJson(PREFS_KEY, preferences)
    return { preferences }
  }),
}))

// Convenience for call sites outside a component (or that don't want to pull
// in the hook just to fire one notification) — e.g. view components' async
// try/catch handlers. Equivalent to useNotificationStore.getState().notify.
export function notify(input: NotifyInput): void {
  useNotificationStore.getState().notify(input)
}

// Shared by the toast and the notification-center list so a click behaves
// identically in both places.
export function runNotificationAction(action: NotificationAction | undefined, setActiveView: (view: ActiveView) => void): void {
  if (!action) return
  if (action.type === 'view') setActiveView(action.view)
  else if (action.command === 'download-update') void window.engine.updaterDownload()
  else if (action.command === 'install-update') void window.engine.updaterQuitInstall()
}
