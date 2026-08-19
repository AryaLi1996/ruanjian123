import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import {
  runNotificationAction,
  useNotificationStore,
  type NotificationRecord,
} from '../../store/useNotificationStore'

/**
 * Toast banners in the corner of the screen (Ticket 35 §3). Rendered once at
 * the app root (see Layout.tsx) — position/duration come from user
 * preferences (Ticket 35 §6). Auto-dismisses after `toastDurationSec`;
 * hovering pauses the countdown (remaining time is preserved, not reset).
 */
export function ToastContainer(): JSX.Element {
  const toasts       = useNotificationStore((s) => s.activeToasts)
  const durationSec  = useNotificationStore((s) => s.preferences.toastDurationSec)
  const position     = useNotificationStore((s) => s.preferences.position)
  const dismissToast = useNotificationStore((s) => s.dismissToast)
  const markRead      = useNotificationStore((s) => s.markRead)
  const setActiveView = useAppStore((s) => s.setActiveView)

  if (toasts.length === 0) return <></>

  return (
    <div className={`toast-container toast-pos-${position}`} aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          toast={toast}
          durationSec={durationSec}
          onDismiss={() => dismissToast(toast.id)}
          onActivate={() => {
            markRead(toast.id)
            runNotificationAction(toast.action, setActiveView)
            dismissToast(toast.id)
          }}
        />
      ))}
    </div>
  )
}

interface ToastProps {
  toast:       NotificationRecord
  durationSec: number
  onDismiss:   () => void
  onActivate:  () => void
}

function Toast({ toast, durationSec, onDismiss, onActivate }: ToastProps): JSX.Element {
  const { t } = useTranslation()
  const [paused, setPaused] = useState(false)

  // Pause-on-hover preserves whatever time was left rather than restarting
  // the full duration — tracked as remaining ms + a start timestamp so the
  // effect below can resume correctly instead of resetting on every hover.
  const remainingMs = useRef(durationSec * 1000)
  const startedAt   = useRef(Date.now())

  useEffect(() => {
    if (paused) return
    startedAt.current = Date.now()
    const timer = setTimeout(onDismiss, remainingMs.current)
    return () => {
      clearTimeout(timer)
      remainingMs.current = Math.max(0, remainingMs.current - (Date.now() - startedAt.current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused])

  const clickable = Boolean(toast.action)

  return (
    <div
      className={`toast toast-cat-${toast.category}${clickable ? ' toast-clickable' : ''}`}
      role="status"
      tabIndex={clickable ? 0 : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={clickable ? onActivate : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate() } } : undefined}
    >
      <span className="toast-icon" aria-hidden="true">{toast.icon}</span>
      <div className="toast-body">
        <div className="toast-title">{t(toast.titleKey, toast.titleParams)}</div>
        {toast.messageKey && <div className="toast-message">{t(toast.messageKey, toast.messageParams)}</div>}
      </div>
      <button
        className="toast-close"
        aria-label={t('common.cancel')}
        onClick={(e) => { e.stopPropagation(); onDismiss() }}
      >
        ×
      </button>
    </div>
  )
}
