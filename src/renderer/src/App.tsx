import { useEffect, useState } from 'react'
import { Layout }          from './components/Layout'
import { ErrorBoundary }   from './components/ErrorBoundary'
import { OnboardingFlow, ONBOARDING_DISMISSED_KEY }  from './components/onboarding/OnboardingFlow'
import { WarmupScreen }    from './components/onboarding/WarmupScreen'
import { useModelLibrary } from './hooks/useModelLibrary'

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
      {startup === 'tutorial' && <OnboardingFlow onClose={() => setStartup('ready')} />}
    </>
  )
}

export default App
