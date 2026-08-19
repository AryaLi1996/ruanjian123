import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import {
  runNotificationAction,
  useNotificationStore,
  type NotificationRecord,
} from '../../store/useNotificationStore'

function formatRelativeTime(ts: number, language: string): string {
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  const diffSec = Math.round((ts - Date.now()) / 1000)
  const abs = Math.abs(diffSec)
  if (abs < 60)    return rtf.format(diffSec, 'second')
  if (abs < 3600)  return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  return rtf.format(Math.round(diffSec / 86400), 'day')
}

/**
 * Bell icon + history dropdown (Ticket 35 §4), mounted in the top toolbar.
 * Owns its own open/close state and closes on an outside click, matching
 * the language <select>'s native-dropdown feel without needing a portal.
 */
export function NotificationCenter(): JSX.Element {
  const { t, i18n } = useTranslation()
  const history           = useNotificationStore((s) => s.history)
  const markRead          = useNotificationStore((s) => s.markRead)
  const markAllRead       = useNotificationStore((s) => s.markAllRead)
  const removeHistoryItem = useNotificationStore((s) => s.removeHistoryItem)
  const clearHistory      = useNotificationStore((s) => s.clearHistory)
  const setActiveView     = useAppStore((s) => s.setActiveView)

  const unreadCount = history.filter((item) => !item.read).length

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function handleItemClick(item: NotificationRecord): void {
    markRead(item.id)
    runNotificationAction(item.action, setActiveView)
    setOpen(false)
  }

  return (
    <div className="notif-center" ref={rootRef}>
      <button
        className="notif-bell-btn"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('notification.center.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('notification.center.title')}
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <span className="notif-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label={t('notification.center.title')}>
          <div className="notif-panel-header">
            <span className="notif-panel-title">{t('notification.center.title')}</span>
            <div className="notif-panel-actions">
              <button
                className="notif-panel-action"
                onClick={markAllRead}
                disabled={unreadCount === 0}
              >
                {t('notification.center.markAllRead')}
              </button>
              <button
                className="notif-panel-action"
                onClick={clearHistory}
                disabled={history.length === 0}
              >
                {t('notification.center.clearAll')}
              </button>
            </div>
          </div>

          <div className="notif-panel-list">
            {history.length === 0 ? (
              <div className="notif-panel-empty">{t('notification.center.empty')}</div>
            ) : (
              history.map((item) => (
                <div
                  key={item.id}
                  className={`notif-item${item.read ? '' : ' notif-item-unread'}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleItemClick(item)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleItemClick(item) }}
                >
                  <span className="notif-item-icon" aria-hidden="true">{item.icon}</span>
                  <div className="notif-item-body">
                    <div className="notif-item-title">{t(item.titleKey, item.titleParams)}</div>
                    {item.messageKey && (
                      <div className="notif-item-message">{t(item.messageKey, item.messageParams)}</div>
                    )}
                    <div className="notif-item-time">{formatRelativeTime(item.createdAt, i18n.language)}</div>
                  </div>
                  {!item.read && <span className="notif-item-dot" aria-hidden="true" />}
                  <button
                    className="notif-item-remove"
                    aria-label={t('common.cancel')}
                    onClick={(e) => { e.stopPropagation(); removeHistoryItem(item.id) }}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
