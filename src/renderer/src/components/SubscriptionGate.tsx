import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSubscriptionStore } from '../store/useSubscriptionStore'

interface Props { children: ReactNode }

async function openCheckout(): Promise<void> {
  const { checkoutUrl } = await window.engine.getLicenseConfig()
  if (!checkoutUrl) return
  window.open(checkoutUrl, '_blank', 'noopener,noreferrer')
}

/**
 * Wraps all gated content.
 * - active / grace_period: renders children (with optional warning banner)
 * - expired / invalid:     shows the full lock screen
 * - unlicensed:            shows the subscribe-to-unlock screen
 * - loading:               shows nothing (brief flash, main process is fast)
 */
export function SubscriptionGate({ children }: Props): JSX.Element {
  const { t } = useTranslation()
  const { status, graceDaysLeft, expiresAt } = useSubscriptionStore()
  const [checkoutReady, setCheckoutReady] = useState(false)

  useEffect(() => {
    window.engine.getLicenseConfig()
      .then(({ checkoutUrl }) => setCheckoutReady(Boolean(checkoutUrl)))
      .catch(() => setCheckoutReady(false))
  }, [])

  if (status === 'loading') return <></>

  if (status === 'expired' || status === 'invalid') {
    return <ExpiredScreen />
  }

  if (status === 'unlicensed') {
    return <UnlicensedScreen />
  }

  const expiryDate = expiresAt
    ? new Date(expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null

  return (
    <>
      {status === 'grace_period' && (
        <div className="grace-banner" role="alert">
          <span>
            ⚠ {t('subscription.graceMessage', { count: graceDaysLeft })}
          </span>
          <button
            className="btn btn-primary grace-renew-btn"
            onClick={openCheckout}
            disabled={!checkoutReady}
          >
            {checkoutReady ? t('subscription.renew') : t('common.paymentUnavailable')}
          </button>
        </div>
      )}
      {children}
    </>
  )
}

function UnlicensedScreen(): JSX.Element {
  const { t } = useTranslation()
  const [checkoutReady, setCheckoutReady] = useState(false)
  useEffect(() => {
    window.engine.getLicenseConfig()
      .then(({ checkoutUrl }) => setCheckoutReady(Boolean(checkoutUrl)))
      .catch(() => setCheckoutReady(false))
  }, [])

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-icon">🔓</div>
        <h2 className="lock-title">{t('subscription.subscribeUnlock')}</h2>
        <p className="lock-desc">{t('subscription.lockDescription')}</p>
        <button
          className="btn btn-primary lock-btn"
          onClick={openCheckout}
          disabled={!checkoutReady}
        >
          {checkoutReady ? `💳 ${t('subscription.subscribeNow')}` : t('common.paymentUnavailable')}
        </button>
        <p className="lock-hint">
          {t('subscription.haveKey')}
        </p>
      </div>
    </div>
  )
}

function ExpiredScreen(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-icon">🔒</div>
        <h2 className="lock-title">{t('subscription.expiredTitle')}</h2>
        <p className="lock-desc">{t('subscription.expiredLockDesc')}</p>
        <button
          className="btn btn-primary lock-btn"
          onClick={openCheckout}
        >
          {t('subscription.renew')}
        </button>
        <p className="lock-hint">
          {t('subscription.haveKey')}
        </p>
      </div>
    </div>
  )
}
