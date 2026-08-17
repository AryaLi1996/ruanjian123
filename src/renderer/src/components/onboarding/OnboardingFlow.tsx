import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const TOTAL_STEPS = 4
export const ONBOARDING_DISMISSED_KEY = 'ruanjian.onboardingDismissed'

interface Props {
  onClose: () => void
}

export function OnboardingFlow({ onClose }: Props): JSX.Element {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  const [dontShowAgain, setDontShowAgain] = useState(false)

  function close(): void {
    if (dontShowAgain) localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1')
    onClose()
  }

  function next(): void {
    if (step === TOTAL_STEPS - 1) close()
    else setStep((current) => current + 1)
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // close() isn't memoized, so depend on the values it actually closes
    // over instead of re-subscribing this listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dontShowAgain, onClose])

  const steps = [
    { icon: '🎤', title: t('onboarding.welcome'), description: t('onboarding.welcomeDesc') },
    { icon: '🏋️', title: t('onboarding.modelTitle'), description: t('onboarding.modelDesc') },
    { icon: '🎵', title: t('onboarding.coverTitle'), description: t('onboarding.coverDesc') },
    { icon: '🔊', title: t('onboarding.toolsTitle'), description: t('onboarding.toolsDesc') },
  ]
  const current = steps[step]

  return (
    <div className="tutorial-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close()
    }}>
      <section className="tutorial-card" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">
        <button className="tutorial-skip" onClick={close} aria-label={t('onboarding.skip')}>
          {t('onboarding.skip')}
        </button>
        <div className="tutorial-progress" aria-label={t('onboarding.progress', { current: step + 1, total: TOTAL_STEPS })}>
          {steps.map((item, index) => (
            <span key={item.title} className={`tutorial-dot${index === step ? ' active' : ''}${index < step ? ' done' : ''}`} />
          ))}
          <span className="tutorial-count">{t('onboarding.progress', { current: step + 1, total: TOTAL_STEPS })}</span>
        </div>
        <div className="tutorial-icon" aria-hidden="true">{current.icon}</div>
        <h1 id="tutorial-title" className="tutorial-title">{current.title}</h1>
        <p className="tutorial-description">{current.description}</p>
        <div className="tutorial-actions">
          {step === 0 && (
            <label className="tutorial-dont-show">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(event) => setDontShowAgain(event.target.checked)}
              />
              {t('onboarding.dontShow')}
            </label>
          )}
          <button className="btn btn-primary" onClick={next}>
            {step === TOTAL_STEPS - 1 ? t('onboarding.getStarted') : t('onboarding.next')}
          </button>
        </div>
      </section>
    </div>
  )
}
