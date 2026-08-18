import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { useAppStore } from '../store/useAppStore'

interface Props { children: ReactNode }

/**
 * Wraps all gated content.
 * - active / grace_period:        renders children (with optional warning banner)
 * - trial active (Ticket 33):     renders children with a dismissible trial banner
 * - expired / invalid, no trial:  shows the full lock screen
 * - unlicensed, trial expired:    shows the trial-expired lock screen
 * - unlicensed, no trial yet:     shows the subscribe-to-unlock screen (trial
 *                                 activation failed or hasn't resolved — rare)
 * - loading:                      shows nothing (brief flash, main process is fast)
 *
 * All CTAs here route to the Subscription page rather than opening a
 * checkout URL directly — that page hosts the full plan + payment method
 * picker (bank card / WeChat Pay / Alipay / Douyin Pay), see Ticket 28.
 */
export function SubscriptionGate({ children }: Props): JSX.Element {
  const { t } = useTranslation()
  const { status, graceDaysLeft, expiresAt, trial } = useSubscriptionStore()
  const setActiveView = useAppStore((s) => s.setActiveView)
  const goToSubscription = (): void => setActiveView('subscription')

  if (status === 'loading') return <></>

  const licensed = status === 'active' || status === 'grace_period'

  if (!licensed && (status === 'expired' || status === 'invalid' || trial.expired)) {
    return <ExpiredScreen onGoToSubscription={goToSubscription} trialExpired={!licensed && trial.expired} />
  }

  if (!licensed && status === 'unlicensed' && !trial.active) {
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
      {!licensed && trial.active && (
        <TrialBanner daysRemaining={trial.daysRemaining} hoursRemaining={trial.hoursRemaining} onSubscribe={goToSubscription} />
      )}
      {children}
    </>
  )
}

function TrialBanner({
  daysRemaining, hoursRemaining, onSubscribe,
}: { daysRemaining: number; hoursRemaining: number; onSubscribe: () => void }): JSX.Element | null {
  const { t } = useTranslation()
  // Component-local, not persisted: resets every app session/restart so the
  // countdown reliably reappears instead of being silenced forever after
  // one dismissal.
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  const label = daysRemaining >= 1
    ? t('trial.banner.remaining', { days: daysRemaining })
    : t('trial.banner.remainingHours', { hours: hoursRemaining })

  return (
    <div className="trial-banner" role="status">
      <span>⏳ {label}</span>
      <div className="trial-banner-actions">
        <button className="btn btn-primary trial-banner-btn" onClick={onSubscribe}>
          {t('trial.banner.subscribe')}
        </button>
        <button
          className="trial-banner-dismiss"
          aria-label={t('common.cancel')}
          onClick={() => setDismissed(true)}
        >
          ✕
        </button>
      </div>
    </div>
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

function ExpiredScreen(
  { onGoToSubscription, trialExpired }: { onGoToSubscription: () => void; trialExpired: boolean },
): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-icon">🔒</div>
        <h2 className="lock-title">
          {trialExpired ? t('trial.expiredTitle') : t('subscription.expiredTitle')}
        </h2>
        <p className="lock-desc">
          {trialExpired ? t('trial.subscription.expired') : t('subscription.expiredLockDesc')}
        </p>
        <button className="btn btn-primary lock-btn" onClick={onGoToSubscription}>
          {trialExpired ? t('subscription.subscribeNow') : t('subscription.renew')}
        </button>
      </div>
    </div>
  )
}
