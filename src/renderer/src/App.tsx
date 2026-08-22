import { useEffect, useState } from 'react'
import { Layout }          from './components/Layout'
import { ErrorBoundary }   from './components/ErrorBoundary'
import { MagicBackdrop }   from './components/MagicBackdrop'
import { OnboardingFlow, ONBOARDING_DISMISSED_KEY }  from './components/onboarding/OnboardingFlow'
import { WarmupScreen }    from './components/onboarding/WarmupScreen'
import { useModelLibrary } from './hooks/useModelLibrary'
import { notify } from './store/useNotificationStore'

// Ticket 35 §5: a welcome notification once the onboarding modal is closed —
// guarded separately from ONBOARDING_DISMISSED_KEY (which only gets set when
// the user checks "don't show again"), so this fires exactly once ever
// rather than every time the tutorial is shown/dismissed.
const WELCOME_NOTIFIED_KEY = 'ruanjian.notifications.welcomeShown'

function App(): JSX.Element {
  useModelLibrary()

  const [startup, setStartup] = useState<'warmup' | 'tutorial' | 'ready'>('warmup')
  const [warmupLoading, setWarmupLoading] = useState(true)
  const [warmupSuccess, setWarmupSuccess] = useState<boolean | null>(null)
  const [warmupError, setWarmupError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    // Reuses the probe main/index.ts already ran at startup instead of
    // spawning a second Python engine process for the same check; main's own
    // 5s budget on the underlying call bounds this.
    window.engine.getWarmupResult().then((result) => {
      if (!active) return
      setWarmupSuccess(result.passed)
      if (!result.passed && result.error) setWarmupError(result.error)
    }).catch((error) => {
      if (active) { setWarmupSuccess(false); setWarmupError(String(error)) }
    }).finally(() => {
      // Wait for the user to click Continue/Skip rather than auto-advancing —
      // otherwise the screen can flash and disappear before it's readable.
      if (active) setWarmupLoading(false)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const show = () => {
      setStartup('tutorial')
      setWarmupLoading(false)
    }
    window.addEventListener('ruanjian:show-onboarding', show)
    return () => window.removeEventListener('ruanjian:show-onboarding', show)
  }, [])

  function finishWarmup(): void {
    setStartup(localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1' ? 'ready' : 'tutorial')
  }

  return (
    <>
      <div className="app-bg-layer" aria-hidden="true" />
      {/* Ticket UI-12: animated cover-derived backdrop. Always mounted so
          its colours can transition between songs rather than popping. */}
      <MagicBackdrop />
      <ErrorBoundary label="root">
        <Layout />
      </ErrorBoundary>
      {startup === 'warmup' && (
        <WarmupScreen
          loading={warmupLoading}
          success={warmupSuccess}
          error={warmupError}
          onSkip={finishWarmup}
          onRetry={() => {
            setWarmupLoading(true)
            setWarmupError(null)
            setWarmupSuccess(null)
            void window.engine.retryWarmup().then((result) => {
              setWarmupSuccess(result.passed)
              if (!result.passed && result.error) setWarmupError(result.error)
            }).catch((error) => {
              setWarmupSuccess(false)
              setWarmupError(String(error))
            }).finally(() => {
              setWarmupLoading(false)
            })
          }}
          onContinue={finishWarmup}
        />
      )}
      {startup === 'tutorial' && (
        <OnboardingFlow
          onClose={() => {
            setStartup('ready')
            try {
              if (localStorage.getItem(WELCOME_NOTIFIED_KEY) !== '1') {
                localStorage.setItem(WELCOME_NOTIFIED_KEY, '1')
                notify({
                  category: 'system',
                  titleKey: 'notification.system.welcome.title',
                  messageKey: 'notification.system.welcome.message',
                })
              }
            } catch { /* best-effort */ }
          }}
        />
      )}
    </>
  )
}

export default App
