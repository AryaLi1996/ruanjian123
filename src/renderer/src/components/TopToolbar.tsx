import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { notify } from '../store/useNotificationStore'
import { NotificationCenter } from './notifications/NotificationCenter'

interface UpdateInfo { version?: string }

// Ticket UI-02 §2: the top bar shows *context* — which workspace is open and
// what it's currently working on — rather than carrying the navigation
// itself, which moved to the sidebar. The per-view key here is the same one
// the sidebar labels with, so the two never disagree about a page's name.
const VIEW_TITLE_KEY: Record<string, string> = {
  training:     'nav.training',
  cover:        'nav.cover',
  'audio-tools': 'nav.audioTools',
  waveform:     'nav.waveform',
  playback:     'nav.playback',
  subscription: 'nav.user',
  settings:     'nav.settings',
}

// Ticket 37 §4 improvement: persisted (not just an in-memory ref) so a
// version the user already saw and dismissed stays silent across app
// restarts too — "does not reappear until a newer version is detected"
// shouldn't reset itself just because the user quit and relaunched before
// updating.
const NOTIFIED_UPDATE_VERSION_KEY = 'ruanjian.lastNotifiedUpdateVersion'

const STATUS_KEY: Record<string, string> = {
  active:       'subscription.active',
  grace_period: 'subscription.grace',
  expired:      'subscription.expired',
  invalid:      'subscription.invalid',
  unlicensed:   'subscription.unlicensed',
  loading:      'common.loading',
}

export function TopToolbar(): JSX.Element {
  const { t } = useTranslation()
  const activeView    = useAppStore((s) => s.activeView)
  const engineBusy    = useAppStore((s) => s.engineBusy)
  const engineStatus  = useAppStore((s) => s.engineStatus)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const targetSong    = useAppStore((s) => s.targetSong)
  const subStatus     = useSubscriptionStore((s) => s.status)

  const [updateInfo,     setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [downloading,    setDownloading] = useState(false)
  const [readyToInstall, setReady]      = useState(false)

  // Ticket 37 §1/§4: checks can now fire repeatedly — the startup timer plus
  // any number of manual "Check for Updates" clicks from Settings — but the
  // "new version available" toast must still show only once per version, not
  // once per check. A ref (not state) survives across those repeated
  // updater:available events without itself triggering a re-render, and
  // isn't reset when the user dismisses the toast, so a re-check for the
  // same version stays silent until a newer one is actually detected. Seeded
  // from localStorage so that holds across app restarts too, not just the
  // current session.
  const notifiedVersionRef = useRef<string | null>(localStorage.getItem(NOTIFIED_UPDATE_VERSION_KEY))

  useEffect(() => {
    const unsub = window.engine.onUpdaterEvent((event, data) => {
      if (event === 'updater:available') {
        const info = data as UpdateInfo
        setUpdateInfo(info)
        const version = info?.version ?? ''
        if (version && notifiedVersionRef.current !== version) {
          notifiedVersionRef.current = version
          localStorage.setItem(NOTIFIED_UPDATE_VERSION_KEY, version)
          // Ticket 35 §5: surface this even if the user is on a different
          // page — the toolbar banner above only exists while TopToolbar is
          // mounted, which it always is, but the notification also lands in
          // history.
          notify({
            category: 'system',
            titleKey: 'notification.system.updateAvailable.title',
            messageKey: 'notification.system.updateAvailable.message',
            messageParams: { version },
            action: { type: 'command', command: 'download-update' },
          })
        }
      }
      if (event === 'updater:progress')   setDownloading(true)
      if (event === 'updater:downloaded') {
        setDownloading(false)
        setReady(true)
        notify({
          category: 'system',
          titleKey: 'notification.system.updateReady.title',
          messageKey: 'notification.system.updateReady.message',
          action: { type: 'command', command: 'install-update' },
        })
      }
      if (event === 'updater:error')      setDownloading(false)
    })
    return unsub
  }, [])

  // The context line under the page title: whatever the current workspace is
  // actually operating on. The engine's own status wins while it's busy
  // (training/separating/synthesizing is the most relevant thing to show),
  // otherwise the selected target song, if any.
  const contextText = engineBusy
    ? engineStatus
    : targetSong
      ? `${targetSong.title}${targetSong.artist ? ` — ${targetSong.artist}` : ''}`
      : null

  return (
    <header className="top-toolbar">
      <div className="tb-context">
        <span className="tb-view-title">{t(VIEW_TITLE_KEY[activeView] ?? 'nav.training')}</span>
        {contextText && (
          <span className="tb-context-text" title={contextText}>{contextText}</span>
        )}
      </div>

      <div className="tb-right">
        <div className="engine-status" title={engineBusy ? engineStatus : t('app.ready')}>
          <span className={`status-dot${engineBusy ? ' busy' : ''}`} />
          <span className="tb-status-text">{engineBusy ? engineStatus : t('app.ready')}</span>
        </div>

        {readyToInstall ? (
          <button className="btn btn-primary tb-update-btn"
            onClick={() => window.engine.updaterQuitInstall()}>
            ✓ {t('updater.install')}
          </button>
        ) : updateInfo ? (
          <button className="btn btn-ghost tb-update-btn"
            disabled={downloading}
            onClick={() => { window.engine.updaterDownload(); setDownloading(true) }}
            title={t('updater.available', { version: updateInfo.version })}>
            {downloading ? `⏳ ${t('updater.downloading')}` : `⬇ ${t('updater.download')}`}
          </button>
        ) : null}

        <button
          className={`tb-sub-badge status-${subStatus}${activeView === 'subscription' ? ' active' : ''}`}
          onClick={() => setActiveView('subscription')}
          title={t('subscription.manage')}
        >
          💎 {t(STATUS_KEY[subStatus] ?? 'subscription.unlicensed')}
        </button>

        <NotificationCenter />

        <label className="tb-language">
          <span className="sr-only">{t('language.label')}</span>
          <select
            value={i18n.language}
            onChange={(event) => {
              const language = event.target.value
              void i18n.changeLanguage(language)
              localStorage.setItem('ruanjian.language', language)
            }}
            aria-label={t('language.label')}
          >
            <option value="zh-CN">{t('language.zh')}</option>
            <option value="en-US">{t('language.en')}</option>
          </select>
        </label>
      </div>
    </header>
  )
}
