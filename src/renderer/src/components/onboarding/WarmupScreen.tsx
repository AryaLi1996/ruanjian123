import { useTranslation } from 'react-i18next'
import { BrandLogo } from '../brand/BrandLogo'

interface Props {
  loading: boolean
  success: boolean | null
  error: string | null
  onSkip: () => void
  onContinue: () => void
  onRetry: () => void
}

// The startup splash screen (Ticket 32 §3) — always renders on the fixed
// dark gradient the logo was designed against, regardless of the user's
// light/dark appearance setting, since it appears before the app itself is
// on screen. Also doubles as the engine warm-up status screen (Ticket 22).
export function WarmupScreen({ loading, success, error, onSkip, onContinue, onRetry }: Props): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="splash-overlay">
      <section className="splash-card" role="dialog" aria-modal="true" aria-labelledby="warmup-title">
        <button className="splash-skip" onClick={onSkip} aria-label={t('onboarding.warmupSkip')}>
          {t('onboarding.warmupSkip')}
        </button>

        <BrandLogo variant="full" size={104} className="splash-logo" />
        <h1 className="splash-name">{t('app.name')}</h1>
        <p className="splash-slogan">{t('app.slogan')}</p>

        <div className="splash-status">
          <h2 id="warmup-title" className="splash-status-title">{t('onboarding.warmup')}</h2>
          {loading && <p className="splash-description">{t('onboarding.warmupRunning')}</p>}
          {!loading && success && <p className="splash-description warmup-success">{t('onboarding.warmupSuccess')}</p>}
          {!loading && !success && (
            <>
              <p className="splash-description">{t('onboarding.warmupFailed')}</p>
              {error && <div className="result-box err ob-error-detail">{error}</div>}
              <button className="btn btn-ghost" onClick={onRetry}>{t('onboarding.retryWarmup')}</button>
            </>
          )}
          {!loading && (
            <button className="btn btn-primary ob-btn" onClick={onContinue}>
              {t('onboarding.warmupContinue')}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
