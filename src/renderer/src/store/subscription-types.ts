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

// ── Multi-channel payment (Ticket 28) ─────────────────────────────────────────

export type PaymentMethod = 'wechat_pay' | 'alipay' | 'douyin_pay' | 'card'
export type PlanId = 'monthly' | 'annual'
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'expired'

export interface PlanDef {
  id: PlanId
  durationDays: number
  amount: number     // minor currency units
  currency: string   // ISO 4217, lowercase
}

export interface PaymentOrder {
  orderId: string
  planId: PlanId
  method: PaymentMethod
  status: OrderStatus
  amount: number
  currency: string
  createdAt: number
  presentAs?: 'embedded' | 'external'
  redirectUrl?: string
}

export interface PaymentHistoryEntry {
  orderId: string
  planId: PlanId
  method: PaymentMethod
  status: OrderStatus
  amount: number
  currency: string
  createdAt: number
  paidAt?: number
}

export interface LicenseConfig {
  checkoutUrl: string
  plans: PlanDef[]
  paymentMethods: PaymentMethod[]
  pollIntervalMs: number
  pollTimeoutMs: number
}
