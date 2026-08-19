import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useNotificationStore,
  notify,
  runNotificationAction,
  MAX_VISIBLE_TOASTS,
  MAX_HISTORY,
} from './useNotificationStore'

const HISTORY_KEY = 'ruanjian.notifications.history'
const PREFS_KEY   = 'ruanjian.notifications.prefs'

function resetStore(): void {
  localStorage.clear()
  useNotificationStore.setState({
    history:      [],
    activeToasts: [],
    toastQueue:   [],
    preferences: {
      categoriesEnabled: { taskCompletion: true, taskFailure: true, subscription: true, system: true, custom: true },
      toastDurationSec: 5,
      position: 'top-right',
    },
  })
}

beforeEach(() => {
  resetStore()
})

describe('notify()', () => {
  it('adds an unread record to history and shows it as an active toast', () => {
    notify({ category: 'taskCompletion', titleKey: 'x.title' })
    const state = useNotificationStore.getState()
    expect(state.history).toHaveLength(1)
    expect(state.activeToasts).toHaveLength(1)
    expect(state.history[0]).toMatchObject({ category: 'taskCompletion', titleKey: 'x.title', read: false, icon: '✓' })
  })

  it('newest notification is first in history (reverse chronological)', () => {
    notify({ category: 'system', titleKey: 'first' })
    notify({ category: 'system', titleKey: 'second' })
    const [top] = useNotificationStore.getState().history
    expect(top.titleKey).toBe('second')
  })

  it('queues toasts beyond MAX_VISIBLE_TOASTS instead of showing them all at once', () => {
    for (let i = 0; i < MAX_VISIBLE_TOASTS + 2; i++) notify({ category: 'system', titleKey: `t${i}` })
    const state = useNotificationStore.getState()
    expect(state.activeToasts).toHaveLength(MAX_VISIBLE_TOASTS)
    expect(state.toastQueue).toHaveLength(2)
    // every notification still lands in history even while its toast waits
    expect(state.history).toHaveLength(MAX_VISIBLE_TOASTS + 2)
  })

  it('promotes the next queued toast when an active one is dismissed', () => {
    for (let i = 0; i < MAX_VISIBLE_TOASTS + 1; i++) notify({ category: 'system', titleKey: `t${i}` })
    const dismissedId = useNotificationStore.getState().activeToasts[0].id

    useNotificationStore.getState().dismissToast(dismissedId)

    const state = useNotificationStore.getState()
    expect(state.activeToasts).toHaveLength(MAX_VISIBLE_TOASTS)
    expect(state.toastQueue).toHaveLength(0)
    expect(state.activeToasts.some((t) => t.id === dismissedId)).toBe(false)
  })

  it('suppresses a notification entirely (no toast, no history entry) when its category is disabled', () => {
    const prefs = useNotificationStore.getState().preferences
    useNotificationStore.getState().setPreferences({
      categoriesEnabled: { ...prefs.categoriesEnabled, taskFailure: false },
    })

    notify({ category: 'taskFailure', titleKey: 'should.be.dropped' })

    const state = useNotificationStore.getState()
    expect(state.history).toHaveLength(0)
    expect(state.activeToasts).toHaveLength(0)
  })

  it('caps history at MAX_HISTORY, dropping the oldest first', () => {
    for (let i = 0; i < MAX_HISTORY + 5; i++) notify({ category: 'system', titleKey: `t${i}` })
    const state = useNotificationStore.getState()
    expect(state.history).toHaveLength(MAX_HISTORY)
    expect(state.history[0].titleKey).toBe(`t${MAX_HISTORY + 4}`)      // newest survives
    expect(state.history.some((h) => h.titleKey === 't0')).toBe(false) // oldest was evicted
  })

  it('persists every new notification to localStorage history', () => {
    notify({ category: 'system', titleKey: 'persisted' })
    const raw = localStorage.getItem(HISTORY_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].titleKey).toBe('persisted')
  })
})

describe('notification-center history management', () => {
  it('markRead only affects the targeted item', () => {
    notify({ category: 'system', titleKey: 'a' })
    notify({ category: 'system', titleKey: 'b' })
    const [newer, older] = useNotificationStore.getState().history

    useNotificationStore.getState().markRead(older.id)

    const state = useNotificationStore.getState()
    expect(state.history.find((h) => h.id === older.id)?.read).toBe(true)
    expect(state.history.find((h) => h.id === newer.id)?.read).toBe(false)
  })

  it('markAllRead clears the unread count', () => {
    notify({ category: 'system', titleKey: 'a' })
    notify({ category: 'system', titleKey: 'b' })

    useNotificationStore.getState().markAllRead()

    const state = useNotificationStore.getState()
    expect(state.history.every((h) => h.read)).toBe(true)
    expect(state.history.filter((h) => !h.read)).toHaveLength(0)
  })

  it('removeHistoryItem deletes one entry without touching the rest', () => {
    notify({ category: 'system', titleKey: 'a' })
    notify({ category: 'system', titleKey: 'b' })
    const [, older] = useNotificationStore.getState().history

    useNotificationStore.getState().removeHistoryItem(older.id)

    const state = useNotificationStore.getState()
    expect(state.history).toHaveLength(1)
    expect(state.history.some((h) => h.id === older.id)).toBe(false)
  })

  it('clearHistory empties history and releases it from localStorage', () => {
    notify({ category: 'system', titleKey: 'a' })
    notify({ category: 'system', titleKey: 'b' })

    useNotificationStore.getState().clearHistory()

    expect(useNotificationStore.getState().history).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY) as string)).toEqual([])
  })
})

describe('preferences', () => {
  it('setPreferences merges into existing preferences rather than replacing them', () => {
    useNotificationStore.getState().setPreferences({ toastDurationSec: 8 })
    const state = useNotificationStore.getState()
    expect(state.preferences.toastDurationSec).toBe(8)
    expect(state.preferences.position).toBe('top-right') // untouched field preserved
    expect(state.preferences.categoriesEnabled.taskCompletion).toBe(true) // untouched nested field preserved
  })

  it('setPreferences persists to localStorage', () => {
    useNotificationStore.getState().setPreferences({ position: 'bottom-right' })
    const persisted = JSON.parse(localStorage.getItem(PREFS_KEY) as string)
    expect(persisted.position).toBe('bottom-right')
  })

  it('a disabled category takes effect immediately for subsequent notify() calls', () => {
    useNotificationStore.getState().setPreferences({
      categoriesEnabled: { ...useNotificationStore.getState().preferences.categoriesEnabled, system: false },
    })
    notify({ category: 'system', titleKey: 'dropped' })
    notify({ category: 'taskCompletion', titleKey: 'kept' })
    const state = useNotificationStore.getState()
    expect(state.history).toHaveLength(1)
    expect(state.history[0].titleKey).toBe('kept')
  })

  // Simulates an app restart: re-imports the module fresh (vi.resetModules
  // clears Vitest's ESM cache) so its module-level loadPreferences()/
  // loadHistory() calls re-run against whatever is currently in
  // localStorage — the same code path a real relaunch takes.
  it('reloading the module picks persisted preferences back up after a restart', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      categoriesEnabled: { taskCompletion: false, taskFailure: true, subscription: true, system: true, custom: true },
      toastDurationSec: 9,
      position: 'bottom-right',
    }))
    vi.resetModules()
    const fresh = await import('./useNotificationStore')
    const prefs = fresh.useNotificationStore.getState().preferences
    expect(prefs.toastDurationSec).toBe(9)
    expect(prefs.position).toBe('bottom-right')
    expect(prefs.categoriesEnabled.taskCompletion).toBe(false)
  })

  it('falls back to the default duration when the persisted value is out of the allowed range', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ toastDurationSec: 999 }))
    vi.resetModules()
    const fresh = await import('./useNotificationStore')
    // 5s is the documented default (Ticket 35 §3: "automatically dismiss
    // after 5 seconds"); an out-of-[3,10]-range persisted value must not
    // silently apply.
    expect(fresh.useNotificationStore.getState().preferences.toastDurationSec).toBe(5)
  })

  it('reloading the module picks persisted history back up, still capped at MAX_HISTORY', async () => {
    const overflow = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => ({
      id: String(i), category: 'system', icon: 'i', titleKey: `t${i}`, createdAt: i, read: false,
    }))
    localStorage.setItem(HISTORY_KEY, JSON.stringify(overflow))
    vi.resetModules()
    const fresh = await import('./useNotificationStore')
    expect(fresh.useNotificationStore.getState().history).toHaveLength(MAX_HISTORY)
  })
})

describe('runNotificationAction()', () => {
  it('does nothing when there is no action', () => {
    const setActiveView = vi.fn()
    expect(() => runNotificationAction(undefined, setActiveView)).not.toThrow()
    expect(setActiveView).not.toHaveBeenCalled()
  })

  it('navigates for a view action', () => {
    const setActiveView = vi.fn()
    runNotificationAction({ type: 'view', view: 'training' }, setActiveView)
    expect(setActiveView).toHaveBeenCalledWith('training')
  })

  it('triggers the updater download for a download-update command', () => {
    const setActiveView = vi.fn()
    const updaterDownload = vi.fn().mockResolvedValue(undefined)
    stubEngine({ updaterDownload })

    runNotificationAction({ type: 'command', command: 'download-update' }, setActiveView)

    expect(updaterDownload).toHaveBeenCalledTimes(1)
    expect(setActiveView).not.toHaveBeenCalled()
  })

  it('triggers quit-and-install for an install-update command', () => {
    const setActiveView = vi.fn()
    const updaterQuitInstall = vi.fn().mockResolvedValue(undefined)
    stubEngine({ updaterQuitInstall })

    runNotificationAction({ type: 'command', command: 'install-update' }, setActiveView)

    expect(updaterQuitInstall).toHaveBeenCalledTimes(1)
  })
})

// Minimal stand-in for the preload-injected window.engine bridge — only the
// methods a given test actually exercises need to be present.
function stubEngine(partial: Record<string, unknown>): void {
  (window as unknown as { engine: Record<string, unknown> }).engine = partial
}
