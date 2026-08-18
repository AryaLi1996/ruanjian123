import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { useAppStore } from '../store/useAppStore'

interface Props { children: ReactNode }

/**
 * Wraps all gated content.
 * - active / grace_period: renders children (with optional warning banner)
 * - expired / invalid:     shows the full lock screen
 * - unlicensed:            shows the subscribe-to-unlock screen
 * - loading:               shows nothing (brief flash, main process is fast)
 *
 * All CTAs here route to the Subscription page rather than opening a
 * checkout URL directly — that page hosts the full plan + payment method
 * picker (bank card / WeChat Pay / Alipay / Douyin Pay), see Ticket 28.
 */
export function SubscriptionGate({ children }: Props): JSX.Element {
  const { t } = useTranslation()
  const { status, graceDaysLeft, expiresAt } = useSubscriptionStore()
  const setActiveView = useAppStore((s) => s.setActiveView)
  const goToSubscription = (): void => setActiveView('subscription')

  if (status === 'loading') return <></>

  if (status === 'expired' || status === 'invalid') {
    return <ExpiredScreen onGoToSubscription={goToSubscription} />
  }

  if (status === 'unlicensed') {
    return <UnlicensedScreen onGoToSubscription={goToSubscription} />
  }

  void expiresAt // reserved for a future "expires soon" banner variant

  return (
    <>
      {status === 'grace_period' && (
        <div className="grace-banner" role="alert">
          <span>
            ⚠ {t('subscription.graceMessage', { count: graceDaysLeft })}
          </span>
          <button className="btn btn-primary grace-renew-btn" onClick={goToSubscription}>
            {t('subscription.renew')}
          </button>
        </div>
      )}
      {children}
    </>
  )
}

function UnlicensedScreen({ onGoToSubscription }: { onGoToSubscription: () => void }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-icon">🔓</div>
        <h2 className="lock-title">{t('subscription.subscribeUnlock')}</h2>
        <p className="lock-desc">{t('subscription.lockDescription')}</p>
        <button className="btn btn-primary lock-btn" onClick={onGoToSubscription}>
          💳 {t('subscription.subscribeNow')}
        </button>
      </div>
    </div>
  )
}

function ExpiredScreen({ onGoToSubscription }: { onGoToSubscription: () => void }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-icon">🔒</div>
        <h2 className="lock-title">{t('subscription.expiredTitle')}</h2>
        <p className="lock-desc">{t('subscription.expiredLockDesc')}</p>
        <button className="btn btn-primary lock-btn" onClick={onGoToSubscription}>
          {t('subscription.renew')}
        </button>
      </div>
    </div>
  )
}
