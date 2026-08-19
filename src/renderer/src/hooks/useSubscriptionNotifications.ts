import { useEffect, useRef } from 'react'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { notify } from '../store/useNotificationStore'

// Fires the Ticket 35 §1 subscription/trial notifications by watching
// useSubscriptionStore for the transitions that matter, rather than adding a
// second push channel from the main process — subscription-monitor.ts
// already pushes every state change to this store via IPC
// (license:state-changed), so this is just where those events become
// user-facing notifications.
//
// Guarded with localStorage flags (keyed to a stable identifier of the
// period being warned about — trialEnd / expiresAt / trialStart) so each
// "expiring soon" or "activated" notice fires once per trial/subscription
// period instead of once per poll tick or every app restart.
const GUARD_PREFIX = 'ruanjian.notifications.guard.'

function guardOnce(key: string): boolean {
  try {
    if (localStorage.getItem(GUARD_PREFIX + key) === '1') return false
    localStorage.setItem(GUARD_PREFIX + key, '1')
    return true
  } catch {
    return true // storage unavailable — still fire, just won't dedupe across restarts
  }
}

export function useSubscriptionNotifications(): void {
  const status        = useSubscriptionStore((s) => s.status)
  const daysRemaining  = useSubscriptionStore((s) => s.daysRemaining)
  const expiresAt      = useSubscriptionStore((s) => s.expiresAt)
  const trial          = useSubscriptionStore((s) => s.trial)

  // null until the first real resolution, so an already-expired/grace-period
  // account doesn't get a spurious "just expired" notification on launch —
  // only an actual in-session transition fires those two.
  const prevStatus = useRef<string | null>(null)

  useEffect(() => {
    if (status === 'loading') return
    const prev = prevStatus.current

    if (status === 'expired' && prev && prev !== 'expired') {
      notify({
        category: 'subscription',
        titleKey: 'notification.subscription.expired.title',
        messageKey: 'notification.subscription.expired.message',
        action: { type: 'view', view: 'subscription' },
      })
    }

    if (status === 'grace_period' && prev && prev !== 'grace_period') {
      notify({
        category: 'subscription',
        titleKey: 'notification.system.licenseGrace.title',
        messageKey: 'notification.system.licenseGrace.message',
        action: { type: 'view', view: 'subscription' },
      })
    }

    if (status === 'active' && daysRemaining > 0 && daysRemaining <= 3 && expiresAt) {
      if (guardOnce(`sub-expiring-${expiresAt}`)) {
        notify({
          category: 'subscription',
          titleKey: 'notification.subscription.expiringSoon.title',
          messageKey: 'notification.subscription.expiringSoon.message',
          messageParams: { days: daysRemaining },
          action: { type: 'view', view: 'subscription' },
        })
      }
    }

    prevStatus.current = status
  }, [status, daysRemaining, expiresAt])

  const prevTrialExpired = useRef<boolean | null>(null)

  useEffect(() => {
    if (!trial || trial.source === 'none') return

    if (trial.active && trial.trialStart && guardOnce(`trial-activated-${trial.trialStart}`)) {
      notify({
        category: 'subscription',
        titleKey: 'notification.trial.activated.title',
        messageKey: 'notification.trial.activated.message',
        action: { type: 'view', view: 'subscription' },
      })
    }

    if (trial.active && trial.hoursRemaining > 0 && trial.hoursRemaining <= 24 && trial.trialEnd) {
      if (guardOnce(`trial-expiring-${trial.trialEnd}`)) {
        notify({
          category: 'subscription',
          titleKey: 'notification.trial.expiringSoon.title',
          messageKey: 'notification.trial.expiringSoon.message',
          messageParams: { hours: trial.hoursRemaining },
          action: { type: 'view', view: 'subscription' },
        })
      }
    }

    if (trial.expired && prevTrialExpired.current === false) {
      notify({
        category: 'subscription',
        titleKey: 'notification.trial.expired.title',
        messageKey: 'notification.trial.expired.message',
        action: { type: 'view', view: 'subscription' },
      })
    }

    prevTrialExpired.current = trial.expired
  }, [trial])
}
