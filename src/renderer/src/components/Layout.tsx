import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/useAppStore'
import { useLayoutStore } from '../store/useLayoutStore'
import { useImmersiveStore } from '../store/useImmersiveStore'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { useSubscriptionNotifications } from '../hooks/useSubscriptionNotifications'
import { useMainNotificationBridge } from '../hooks/useMainNotificationBridge'
import { TopToolbar } from './TopToolbar'
import { Sidebar } from './Sidebar'
import { PlayerBar } from './PlayerBar'
import { TrainingView }   from '../views/TrainingView'
import { CoverView }      from '../views/CoverView'
import { AudioToolsView } from '../views/AudioToolsView'
import { DataPrepView } from '../views/DataPrepView'
import { PlaybackMonitorView } from '../views/PlaybackMonitorView'
import { LibraryView } from '../views/LibraryView'
import { SubscriptionView } from '../views/SubscriptionView'
import { SettingsView } from '../views/SettingsView'
import { SubscriptionGate } from './SubscriptionGate'
import { ErrorBoundary } from './ErrorBoundary'
import { ToastContainer } from './notifications/ToastContainer'

export function Layout(): JSX.Element {
  const { t } = useTranslation()
  const activeView = useAppStore((s) => s.activeView)
  const collapsed  = useLayoutStore((s) => s.sidebarCollapsed)
  const immersive  = useImmersiveStore((s) => s.immersive)
  const setImmersive = useImmersiveStore((s) => s.setImmersive)
  const _init      = useSubscriptionStore((s) => s._init)

  // Sync subscription state from main process on mount
  useEffect(() => { _init() }, [_init])

  // Watches subscription/trial state for the transitions Ticket 35 §1/§5
  // needs to notify on (expiring soon, expired, grace period, activated).
  useSubscriptionNotifications()
  // Ticket 35 §2/§8: main-process-originated notifications (updater errors,
  // renderer-crash recovery — see main/notification-bridge.ts).
  useMainNotificationBridge()

  // Ticket UI-12: F toggles immersive mode, Escape leaves it. Ignored while
  // the user is typing, so F stays a letter in every text field in the app.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        useImmersiveStore.getState().toggleImmersive()
      } else if (event.key === 'Escape') {
        // Only claims Escape when it has something to do, so it still
        // closes dialogs and modals the rest of the time.
        if (useImmersiveStore.getState().immersive) setImmersive(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setImmersive])

  const isSubView      = (activeView as string) === 'subscription'
  const isSettingsView = (activeView as string) === 'settings'
  // Appearance/theme prefs and the subscription page itself must stay
  // reachable even when the licence is expired or unset.
  const bypassesGate = isSubView || isSettingsView

  const view = isSubView      ? <SubscriptionView /> :
    isSettingsView             ? <SettingsView />      :
    activeView === 'training'  ? <TrainingView />      :
    activeView === 'cover'     ? <CoverView />         :
    activeView === 'waveform'  ? <DataPrepView /> :
    activeView === 'playback'  ? <PlaybackMonitorView /> :
    activeView === 'library'   ? <LibraryView /> :
                                 <AudioToolsView />

  // Ticket UI-02: the four-module shell — sidebar | (header / main) with a
  // full-width player bar pinned underneath. The grid itself lives in
  // app.css (.app-layout); `sidebar-collapsed` is what animates the column
  // track from 240px to 60px.
  return (
    <div className={`app-layout${collapsed ? ' sidebar-collapsed' : ''}${immersive ? ' immersive' : ''}`}>
      <Sidebar />
      <TopToolbar />
      <main
        className={`content-area${activeView === 'playback' ? ' content-area-wide' : ''}`}
        key={activeView}
      >
        <ErrorBoundary label={activeView}>
          {bypassesGate ? view : <SubscriptionGate>{view}</SubscriptionGate>}
        </ErrorBoundary>
      </main>
      {immersive && (
        <button
          type="button"
          className="immersive-exit"
          onClick={() => setImmersive(false)}
          title={t('immersive.exit')}
        >
          ✕ {t('immersive.exit')}
        </button>
      )}

      <PlayerBar />
      {/* Toasts render above the whole layout regardless of activeView, so a
          background task finishing on another page is still seen (Ticket 35 §3). */}
      <ToastContainer />
    </div>
  )
}
