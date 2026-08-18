import { create } from 'zustand'
import type { LicenseStatus, SubscriptionState, TrialState } from './subscription-types'

// Re-export for use in renderer (avoids importing from main process)
export type { LicenseStatus, SubscriptionState, TrialState }

const initialTrial: TrialState = {
  active: false, expired: false, trialStart: null, trialEnd: null,
  daysRemaining: 0, hoursRemaining: 0, source: 'none',
}

interface SubStore extends SubscriptionState {
  _init: () => Promise<void>
}

export const useSubscriptionStore = create<SubStore>((set) => ({
  status:        'loading',
  payload:       null,
  expiresAt:     null,
  graceDaysLeft: 0,
  daysRemaining: 0,
  trial:         initialTrial,

  _init: async () => {
    const state = await window.engine.getLicenseState() as SubscriptionState
    set(state)

    // Subscribe to state changes pushed from the main process
    window.engine.onLicenseStateChange((newState) => {
      set(newState as SubscriptionState)
    })
  },
}))
