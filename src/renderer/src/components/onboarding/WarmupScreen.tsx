import { useTranslation } from 'react-i18next'

interface Props {
  loading: boolean
  success: boolean | null
  error: string | null
  onSkip: () => void
  onContinue: () => void
  onRetry: () => void
}

export function WarmupScreen({ loading, success, error, onSkip, onContinue, onRetry }: Props): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="tutorial-overlay">
      <section className="tutorial-card warmup-card" role="dialog" aria-modal="true" aria-labelledby="warmup-title">
        <button className="tutorial-skip" onClick={onSkip} aria-label={t('onboarding.warmupSkip')}>
          {t('onboarding.warmupSkip')}
        </button>
        <div className="tutorial-icon">🔥</div>
        <h1 id="warmup-title" className="tutorial-title">{t('onboarding.warmup')}</h1>
        {loading && <p className="tutorial-description">{t('onboarding.warmupRunning')}</p>}
        {!loading && success && <p className="tutorial-description warmup-success">{t('onboarding.warmupSuccess')}</p>}
        {!loading && !success && (
          <>
            <p className="tutorial-description">{t('onboarding.warmupFailed')}</p>
            {error && <div className="result-box err ob-error-detail">{error}</div>}
            <button className="btn btn-ghost" onClick={onRetry}>{t('onboarding.retryWarmup')}</button>
          </>
        )}
        {!loading && (
          <button className="btn btn-primary ob-btn" onClick={onContinue}>
            {t('onboarding.warmupContinue')}
          </button>
        )}
      </section>
    </div>
  )
}
