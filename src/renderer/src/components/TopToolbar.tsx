import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import { useAppStore, type ActiveView } from '../store/useAppStore'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { useSettingsStore } from '../store/useSettingsStore'
import { BrandLogo } from './brand/BrandLogo'

interface NavItem { view: ActiveView; icon: string; key: string }
interface UpdateInfo { version?: string }

const NAV_ITEMS: NavItem[] = [
  { view: 'training',    icon: '🏋️', key: 'training' },
  { view: 'cover',       icon: '🎤', key: 'cover' },
  { view: 'audio-tools', icon: '🔊', key: 'audioTools' },
  { view: 'playback',    icon: '🎚️', key: 'playback' },
]

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
  const subStatus     = useSubscriptionStore((s) => s.status)
  const avatarDataUrl = useSettingsStore((s) => s.avatarDataUrl)

  const [updateInfo,     setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [downloading,    setDownloading] = useState(false)
  const [readyToInstall, setReady]      = useState(false)

  useEffect(() => {
    const unsub = window.engine.onUpdaterEvent((event, data) => {
      if (event === 'updater:available')  setUpdateInfo(data as UpdateInfo)
      if (event === 'updater:progress')   setDownloading(true)
      if (event === 'updater:downloaded') { setDownloading(false); setReady(true) }
      if (event === 'updater:error')      setDownloading(false)
    })
    return unsub
  }, [])

  return (
    <header className="top-toolbar">
      <div className="tb-brand">
        <BrandLogo variant="simple" size={24} className="tb-logo" />
        <span className="tb-title">{t('app.name')}</span>
      </div>

      <nav className="tb-nav" role="navigation" aria-label="Main navigation">
        {NAV_ITEMS.map(({ view, icon, key }) => (
          <button
            key={view}
            className={`tb-nav-item${activeView === view ? ' active' : ''}`}
            onClick={() => setActiveView(view)}
            aria-current={activeView === view ? 'page' : undefined}
          >
            <span className="nav-icon" aria-hidden="true">{icon}</span>
            <span className="tb-nav-label">{t(`nav.${key}`)}</span>
          </button>
        ))}
      </nav>

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

        <button
          className={`tb-settings-btn${activeView === 'settings' ? ' active' : ''}`}
          onClick={() => setActiveView('settings')}
          title={t('settings.title')}
          aria-current={activeView === 'settings' ? 'page' : undefined}
        >
          {avatarDataUrl
            ? <img src={avatarDataUrl} alt="" className="tb-settings-avatar" />
            : <span aria-hidden="true">⚙️</span>}
          <span className="sr-only">{t('settings.title')}</span>
        </button>
      </div>
    </header>
  )
}
