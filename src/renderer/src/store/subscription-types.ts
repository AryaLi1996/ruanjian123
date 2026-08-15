export type LicenseStatus =
  | 'loading'
  | 'unlicensed'
  | 'active'
  | 'grace_period'
  | 'expired'
  | 'invalid'

export interface LicensePayload {
  userId: string
  planId: 'monthly' | 'annual' | 'trial'
  licenseKey: string
  expiresAt: number
  issuedAt: number
  features: string[]
}

export interface SubscriptionState {
  status: LicenseStatus
  payload: LicensePayload | null
  expiresAt: string | null
  graceDaysLeft: number
  daysRemaining: number
}

export interface ActivationResult {
  success: boolean
  error?: string
  state?: SubscriptionState
}
