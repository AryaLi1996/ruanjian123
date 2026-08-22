import { useTranslation } from 'react-i18next'
import { useAppStore, type ActiveView } from '../store/useAppStore'
import { useLayoutStore } from '../store/useLayoutStore'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { useSettingsStore } from '../store/useSettingsStore'
import { BrandLogo } from './brand/BrandLogo'

// Ticket UI-02 §1 names 作歌曲 / 模型 / 云曲库 / 用户 / 设置 as the sidebar's
// entries. The app's other first-class workspaces (audio tools, waveform
// editor, playback/monitor) live here too rather than being dropped — the
// nav moved wholesale out of the top toolbar, so anything missing from this
// list would become unreachable.
interface NavEntry { view: ActiveView; icon: string; key: string }

const PRIMARY_NAV: NavEntry[] = [
  { view: 'cover',       icon: '🎤',  key: 'cover' },
  { view: 'training',    icon: '🏋️',  key: 'training' },
  { view: 'audio-tools', icon: '🔊',  key: 'audioTools' },
  { view: 'waveform',    icon: '〰️',  key: 'waveform' },
  { view: 'playback',    icon: '🎚️',  key: 'playback' },
]

// Account/preferences entries, pinned to the bottom away from the workspace
// list above.
const FOOTER_NAV: NavEntry[] = [
  { view: 'subscription', icon: '💎', key: 'user' },
  { view: 'settings',     icon: '⚙️', key: 'settings' },
]

export function Sidebar(): JSX.Element {
  const { t } = useTranslation()
  const activeView      = useAppStore((s) => s.activeView)
  const setActiveView   = useAppStore((s) => s.setActiveView)
  const setLibraryOpen  = useAppStore((s) => s.setLibraryOpen)
  const collapsed       = useLayoutStore((s) => s.sidebarCollapsed)
  const toggleSidebar   = useLayoutStore((s) => s.toggleSidebar)
  const subStatus       = useSubscriptionStore((s) => s.status)
  const avatarDataUrl   = useSettingsStore((s) => s.avatarDataUrl)

  // 云曲库 is a modal owned by the Cover page rather than a view of its own,
  // so this entry navigates there and asks it to open — see useAppStore's
  // libraryOpen.
  function openLibrary(): void {
    setActiveView('cover')
    setLibraryOpen(true)
  }

  // Collapsed, every row is icon-only, so the accessible name has to come
  // from title/aria-label instead of the (visually hidden) text label.
  function renderNavButton({ view, icon, key }: NavEntry): JSX.Element {
    const label = t(`nav.${key}`)
    const isActive = activeView === view
    return (
      <button
        key={view}
        className={`sb-nav-item${isActive ? ' active' : ''}`}
        onClick={() => setActiveView(view)}
        aria-current={isActive ? 'page' : undefined}
        title={collapsed ? label : undefined}
      >
        <span className="sb-nav-icon" aria-hidden="true">{icon}</span>
        <span className="sb-nav-label">{label}</span>
      </button>
    )
  }

  return (
    <aside className={`app-sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sb-brand">
        <BrandLogo variant="simple" size={26} className="sb-logo" />
        <span className="sb-brand-name">{t('app.name')}</span>
      </div>

      <nav className="sb-nav" role="navigation" aria-label={t('nav.primary')}>
        {PRIMARY_NAV.map(renderNavButton)}

        <button
          className="sb-nav-item"
          onClick={openLibrary}
          title={collapsed ? t('nav.library') : undefined}
        >
          <span className="sb-nav-icon" aria-hidden="true">☁️</span>
          <span className="sb-nav-label">{t('nav.library')}</span>
        </button>
      </nav>

      <div className="sb-footer">
        {FOOTER_NAV.map(({ view, icon, key }) => {
          const label = t(`nav.${key}`)
          const isActive = activeView === view
          // The user row doubles as the account indicator: it shows the
          // chosen avatar in place of the generic icon, and carries the
          // subscription state as a dot so an expired licence is visible
          // even with the sidebar collapsed.
          const isUser = view === 'subscription'
          return (
            <button
              key={view}
              className={`sb-nav-item${isActive ? ' active' : ''}`}
              onClick={() => setActiveView(view)}
              aria-current={isActive ? 'page' : undefined}
              title={collapsed ? label : undefined}
            >
              <span className="sb-nav-icon" aria-hidden="true">
                {isUser && avatarDataUrl
                  ? <img src={avatarDataUrl} alt="" className="sb-avatar" />
                  : icon}
                {isUser && <span className={`sb-sub-dot status-${subStatus}`} />}
              </span>
              <span className="sb-nav-label">{label}</span>
            </button>
          )
        })}

        <button
          className="sb-collapse-btn"
          onClick={toggleSidebar}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-expanded={!collapsed}
        >
          <span className="sb-collapse-icon" aria-hidden="true">{collapsed ? '»' : '«'}</span>
          <span className="sb-nav-label">{t('sidebar.collapse')}</span>
        </button>
      </div>
    </aside>
  )
}
