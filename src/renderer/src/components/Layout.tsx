import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { TopToolbar } from './TopToolbar'
import { TrainingView }   from '../views/TrainingView'
import { CoverView }      from '../views/CoverView'
import { AudioToolsView } from '../views/AudioToolsView'
import { PlaybackMonitorView } from '../views/PlaybackMonitorView'
import { SubscriptionView } from '../views/SubscriptionView'
import { SettingsView } from '../views/SettingsView'
import { SubscriptionGate } from './SubscriptionGate'
import { ErrorBoundary } from './ErrorBoundary'

export function Layout(): JSX.Element {
  const activeView = useAppStore((s) => s.activeView)
  const _init      = useSubscriptionStore((s) => s._init)

  // Sync subscription state from main process on mount
  useEffect(() => { _init() }, [_init])

  const isSubView      = (activeView as string) === 'subscription'
  const isSettingsView = (activeView as string) === 'settings'
  // Appearance/theme prefs and the subscription page itself must stay
  // reachable even when the licence is expired or unset.
  const bypassesGate = isSubView || isSettingsView

  const view = isSubView      ? <SubscriptionView /> :
    isSettingsView             ? <SettingsView />      :
    activeView === 'training'  ? <TrainingView />      :
    activeView === 'cover'     ? <CoverView />         :
    activeView === 'playback'  ? <PlaybackMonitorView /> :
                                 <AudioToolsView />

  return (
    <div className="app-layout">
      <TopToolbar />
      <main
        className={`content-area${activeView === 'playback' ? ' content-area-wide' : ''}`}
        key={activeView}
      >
        <ErrorBoundary label={activeView}>
          {bypassesGate ? view : <SubscriptionGate>{view}</SubscriptionGate>}
        </ErrorBoundary>
      </main>
    </div>
  )
}
