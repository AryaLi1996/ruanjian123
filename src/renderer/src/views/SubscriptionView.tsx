import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import type { ActivationResult } from '../store/subscription-types'

async function openCheckout(): Promise<void> {
  const { checkoutUrl } = await window.engine.getLicenseConfig()
  if (!checkoutUrl) return
  window.open(checkoutUrl, '_blank', 'noopener,noreferrer')
}

export function SubscriptionView(): JSX.Element {
  const { t, i18n } = useTranslation()
  const { status, expiresAt, daysRemaining, graceDaysLeft, payload } =
    useSubscriptionStore()

  const [key,       setKey]       = useState('')
  const [activating, setActivating] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [success,   setSuccess]   = useState<string | null>(null)
  const [checkoutReady, setCheckoutReady] = useState(false)

  useEffect(() => {
    window.engine.getLicenseConfig()
      .then(({ checkoutUrl }) => setCheckoutReady(Boolean(checkoutUrl)))
      .catch(() => setCheckoutReady(false))
  }, [])

  async function handleActivate(): Promise<void> {
    if (!key.trim()) return
    setActivating(true); setError(null); setSuccess(null)
    try {
      const res = await window.engine.activateLicense(key.trim()) as ActivationResult
      if (res.success) setSuccess('✓ License activated! All features unlocked.')
      else             setError(res.error ?? 'Activation failed')
    } catch (err) {
      setError(String(err))
    } finally {
      setActivating(false)
    }
  }

  function showTutorialAgain(): void {
    localStorage.removeItem('ruanjian.onboardingDismissed')
    window.dispatchEvent(new Event('ruanjian:show-onboarding'))
  }

  const expiryDate = expiresAt
    ? new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(expiresAt))
    : null

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">{t('subscription.title')}</h1>
        <p className="view-desc">{t('subscription.description')}</p>
      </div>

      {/* ── Status card ────────────────────────────────── */}
      <div className="card">
        <div className="card-title">{t('subscription.status')}</div>
        <div className="sub-status-grid">
          <div className="sub-row">
            <span>{t('subscription.status')}</span>
            <SubStatusBadge status={status} />
          </div>
          {payload && (
            <>
              <div className="sub-row">
                <span>{t('subscription.plan')}</span>
                <strong>{t(`subscription.${payload.planId}`)}</strong>
              </div>
              <div className="sub-row">
                <span>{t('subscription.validUntil')}</span>
                <strong>{expiryDate ?? '—'}</strong>
              </div>
              {status === 'active' && daysRemaining > 0 && (
                <div className="sub-row">
                  <span>{t('subscription.daysRemaining')}</span>
                  <strong className="sub-days">{daysRemaining}</strong>
                </div>
              )}
              {status === 'grace_period' && (
                <div className="sub-row">
                  <span>{t('subscription.grace')}</span>
                  <strong style={{ color: '#f59e0b' }}>{graceDaysLeft}</strong>
                </div>
              )}
              <div className="sub-row">
                <span>{t('subscription.features')}</span>
                <strong>{payload.features.join(', ')}</strong>
              </div>
            </>
          )}
        </div>

        {(status === 'active' || status === 'grace_period') && (
          <div className="row" style={{ marginTop: 16, gap: 10 }}>
            <button
              className="btn btn-primary"
              onClick={openCheckout}
              disabled={!checkoutReady}
            >
              {checkoutReady ? t('subscription.manage') : t('common.paymentUnavailable')}
            </button>
              <button className="btn btn-ghost" onClick={() => window.engine.refreshLicense()}>
              {t('common.refresh')}
            </button>
            <button
              className="btn btn-ghost"
              style={{ color: 'var(--text-muted)', fontSize: 12 }}
              onClick={() => window.engine.deactivateLicense()}
            >
              {t('common.deactivate')}
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">{t('onboarding.showAgain')}</div>
        <button className="btn btn-ghost" onClick={showTutorialAgain}>
          {t('onboarding.showAgain')}
        </button>
      </div>

      {/* ── Activate / Renew ───────────────────────────── */}
      {(status === 'unlicensed' || status === 'expired' || status === 'grace_period') && (
        <div className="card">
          <div className="card-title">
            {status === 'unlicensed' ? t('subscription.activateTitle') : t('subscription.renewTitle')}
          </div>

          <div className="sub-cta">
            <p className="sub-cta-desc">
              {status === 'unlicensed'
                ? t('subscription.enterKey')
                : t('subscription.expiredDesc')}
            </p>
            <button
              className="btn btn-primary sub-checkout-btn"
              onClick={openCheckout}
              disabled={!checkoutReady}
            >
              {checkoutReady ? `💳 ${t('subscription.subscribe')}` : t('common.paymentUnavailable')}
            </button>
          </div>

          <div style={{ marginTop: 20 }}>
            <label className="field" style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('subscription.activateKey')}
              </span>
            </label>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <input
                className="input"
                placeholder={t('subscription.keyPlaceholder')}
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                disabled={activating}
                style={{ flex: 1, fontFamily: 'monospace' }}
              />
              <button
                className="btn btn-primary"
                onClick={handleActivate}
                disabled={activating || !key.trim()}
                style={{ flexShrink: 0 }}
              >
                {activating ? `⏳ ${t('subscription.activating')}` : t('common.activate')}
              </button>
            </div>
            {error   && <div className="error-banner"  style={{ marginTop: 10 }}>{error}</div>}
            {success && <div className="sub-success"   style={{ marginTop: 10 }}>{success}</div>}
            <p className="sub-demo-hint">
              {t('subscription.demo')}
            </p>
          </div>
        </div>
      )}
    </>
  )
}

function SubStatusBadge({ status }: { status: string }): JSX.Element {
  const { t } = useTranslation()
  const map: Record<string, [string, string]> = {
    loading:      ['var(--text-muted)',  t('common.loading')],
    unlicensed:   ['var(--text-muted)',  t('subscription.unlicensed')],
    active:       ['var(--success)',     t('subscription.active')],
    grace_period: ['#f59e0b',           t('subscription.grace')],
    expired:      ['var(--danger)',      t('subscription.expired')],
    invalid:      ['var(--danger)',      t('subscription.invalid')],
  }
  const [color, label] = map[status] ?? ['var(--text-muted)', status]
  return <strong style={{ color }}>{label}</strong>
}
