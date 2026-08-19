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

// ── Free trial (Ticket 33) ────────────────────────────────────────────────────
export interface TrialState {
  active: boolean
  expired: boolean
  trialStart: number | null // Unix seconds
  trialEnd: number | null   // Unix seconds
  daysRemaining: number     // ceil, for the banner; 0 when < 1 day left
  hoursRemaining: number    // ceil, used instead of daysRemaining when < 24h left
  source: 'none' | 'local' | 'server'
}

export interface SubscriptionState {
  status: LicenseStatus
  payload: LicensePayload | null
  expiresAt: string | null
  graceDaysLeft: number
  daysRemaining: number
  trial: TrialState
}

export interface ActivationResult {
  success: boolean
  error?: string
  state?: SubscriptionState
}

// ── Multi-channel payment (Ticket 28) ─────────────────────────────────────────

export type PaymentMethod = 'wechat_pay' | 'alipay' | 'douyin_pay' | 'card'
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'expired'

// ── Multi-period plans (Ticket 34) ────────────────────────────────────────────
export type PlanId = 'monthly' | 'quarterly' | 'semi_annual' | 'annual'
export type PlanPeriod = 'month' | 'quarter' | 'half_year' | 'year'

export interface PlanDef {
  id: PlanId
  period: PlanPeriod
  durationDays: number
  discountPercent: number
  price: number           // major units (e.g. yuan) — display/reference only
  priceUSD: number         // display-only USD equivalent (Ticket 36) — never used for billing
  originalPrice: number    // pre-discount reference total (same currency as `price`) — for the strikethrough price
  originalPriceUSD: number // display-only USD equivalent of originalPrice (Ticket 36)
  amount: number       // minor currency units
  currency: string   // ISO 4217, lowercase
}

// Live, server-computed plan pricing — see GET /plans in handler.py's
// _handle_get_plans(). Distinct from PlanDef/LicenseConfig.plans below,
// which is only the offline fallback used when this fetch fails (same
// relationship as PaymentMethodInfo vs. LicenseConfig.paymentMethods).
export interface PlanInfo {
  id: PlanId
  period: PlanPeriod
  durationDays: number
  discountPercent: number
  price: number           // major units (e.g. yuan)
  priceUSD: number         // display-only USD equivalent (Ticket 36) — never used for billing
  originalPrice: number    // pre-discount reference total (same currency as `price`) — for the strikethrough price
  originalPriceUSD: number // display-only USD equivalent of originalPrice (Ticket 36)
  currency: string
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

// ── Dynamic payment-method availability (Ticket 31) ───────────────────────────
// Distinct from LicenseConfig.paymentMethods above, which is the static list
// of methods this build *knows how to render* (a fallback badge/i18n label
// exists for them, used for historical orders — see SubscriptionView.tsx).
// PaymentMethodInfo is the live, server-computed subset that's actually
// usable right now, complete with its own localized display metadata — see
// /payment-methods in serverless/verify-license/handler.py.
export interface PaymentMethodInfo {
  id: PaymentMethod
  enabled: boolean
  name: string
  icon: string
  color: string | null // null → render with the app's current theme accent
}
