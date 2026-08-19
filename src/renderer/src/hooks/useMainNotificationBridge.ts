import { useEffect } from 'react'
import { notify, type NotificationCategory, type NotifyInput } from '../store/useNotificationStore'

const KNOWN_CATEGORIES: NotificationCategory[] = ['taskCompletion', 'taskFailure', 'subscription', 'system', 'custom']

function isNotifyInput(payload: unknown): payload is NotifyInput {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  return typeof p.titleKey === 'string'
    && typeof p.category === 'string'
    && KNOWN_CATEGORIES.includes(p.category as NotificationCategory)
}

/**
 * Forwards notifications pushed from the main process (Ticket 35 §2/§8 —
 * see main/notification-bridge.ts) into the renderer's own notification
 * store, so they render as the exact same toast/history entry as a
 * renderer-triggered one. Lightly validated before forwarding: this is our
 * own trusted main process, not untrusted input, but it's still crossing a
 * process boundary as `unknown`, and a malformed payload should be dropped
 * rather than fed into the store as-is.
 */
export function useMainNotificationBridge(): void {
  useEffect(() => {
    return window.engine.onMainNotification((payload) => {
      if (isNotifyInput(payload)) notify(payload)
    })
  }, [])
}
