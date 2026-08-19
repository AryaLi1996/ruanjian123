/**
 * License & subscription configuration.
 *
 * To change payment provider or verification logic, update ONLY this file
 * and redeploy the serverless function under serverless/verify-license/.
 *
 * Supported providers: 'stripe' | 'lemonsqueezy' | 'paddle' | 'custom'
 */
// Ships in source control as a template default — never a real secret. Must
// match the fallback in serverless/verify-license/handler.py's SIGNING_SECRET.
// Anyone can read this string, so a packaged build still running with it
// active can have its license tokens forged offline; see the warning below.
const DEFAULT_SIGNING_SECRET = 'ruanjian-dev-signing-secret-v1-change-in-production'

// ── Multi-channel payment (Ticket 28) ─────────────────────────────────────────
// One payment = one order = license extended by that plan's duration.
// This is independent of Stripe's own "subscription" object — the source of
// truth for expiry is our own signed license token, not Stripe billing state.
export type PaymentMethod = 'wechat_pay' | 'alipay' | 'douyin_pay' | 'card'

// ── Multi-period plans (Ticket 34, pricing updated by Ticket 36) ──────────────
// Four billing periods, each a discount off the per-month base rate:
// monthly 0%, quarterly 5%, semi-annual 10%, annual 15%.
export type PlanId     = 'monthly' | 'quarterly' | 'semi_annual' | 'annual'
export type PlanPeriod = 'month' | 'quarter' | 'half_year' | 'year'

export interface PlanDef {
  id:              PlanId
  period:          PlanPeriod
  durationDays:    number
  discountPercent: number
  price:           number   // major units (e.g. yuan) — display/reference only
  priceUSD:        number   // display-only USD equivalent (Ticket 36) — never used for billing
  amount:          number   // minor currency units (e.g. fen for CNY, cents for USD)
  currency:        string   // ISO 4217, lowercase — must match the serverless PLAN config
}

// This whole block is an OFFLINE FALLBACK ONLY, used if a live GET /plans
// fetch fails (see subscription-monitor.ts's getPlans()) — the serverless
// function's _build_plans() in handler.py is the actual source of truth for
// pricing (BASE_MONTHLY_PRICE/PLAN_CURRENCY/USD_EXCHANGE_RATE env vars). Keep
// this formula and the default price/rate in sync with that file's default.
//
// NOTE: WeChat Pay / Alipay via Stripe Checkout only support a subset of
// presentment currencies, and that list can change — confirm the current one
// in the Stripe docs before choosing `currency` for a real deployment.
const _FALLBACK_BASE_MONTHLY_PRICE = 99 // RMB (Ticket 36)
const _FALLBACK_CURRENCY = 'cny'
// Exported so subscription-monitor.ts's getPlans() can derive priceUSD for a
// live /plans response that (e.g. an older server build) omits the field.
export const FALLBACK_USD_EXCHANGE_RATE = 7.0

function _planPrice(months: number, discountPercent: number): number {
  const raw = _FALLBACK_BASE_MONTHLY_PRICE * months * (1 - discountPercent / 100)
  // RMB rounds to whole yuan (Ticket 36 §2's "取整到元"), unlike the old
  // USD pricing which rounded to cents.
  return Math.round(raw + Number.EPSILON)
}

function _planPriceUSD(priceMajorUnits: number): number {
  return Math.round(priceMajorUnits / FALLBACK_USD_EXCHANGE_RATE)
}

function _plan(id: PlanId, period: PlanPeriod, durationDays: number, months: number, discountPercent: number): PlanDef {
  const price = _planPrice(months, discountPercent)
  return {
    id, period, durationDays, discountPercent, price,
    priceUSD: _planPriceUSD(price),
    amount:   Math.round(price * 100),
    currency: _FALLBACK_CURRENCY,
  }
}

export const PLANS: readonly PlanDef[] = [
  _plan('monthly',     'month',     30,  1,  0),   // full price
  _plan('quarterly',   'quarter',   90,  3,  5),   // 5% off
  _plan('semi_annual', 'half_year', 180, 6,  10),  // 10% off
  _plan('annual',      'year',      365, 12, 15),  // 15% off — best value
] as const

export const PAYMENT_METHODS: readonly PaymentMethod[] = ['wechat_pay', 'alipay', 'douyin_pay', 'card']

export const LICENSE_CONFIG = {
  // ── Serverless verification endpoint ───────────────────────────────────────
  // Replace with your actual deployed URL. All payment routes below live on
  // this same Function URL, dispatched by path (see serverless/verify-license).
  // Set VITE_LICENSE_URL (renderer) or LICENSE_URL (main) env var in production.
  verificationUrl: process.env['LICENSE_URL'] ??
    'https://5pmjnezmzrbjw2tjmnzpt232xy0duvyr.lambda-url.us-east-1.on.aws/',

  // ── HMAC signing secret (shared with serverless function) ──────────────────
  // In production: use RSA – server signs with private key, app verifies with
  // public key embedded here.  For HMAC (this template): rotate via app update.
  signingSecret: process.env['LICENSE_SIGNING_SECRET'] ?? DEFAULT_SIGNING_SECRET,

  // ── Payment checkout URL (legacy: static Stripe Payment Link / "Manage") ───
  checkoutUrl: process.env['CHECKOUT_URL'] ?? '',

  // ── Subscription enforcement ────────────────────────────────────────────────
  gracePeriodDays:      3,     // days after expiry before full lockout
  refreshIntervalHours: 12,   // background token refresh cadence

  // ── Provider tag (for future switch) ───────────────────────────────────────
  provider: (process.env['LICENSE_PROVIDER'] ?? 'custom') as
    'stripe' | 'lemonsqueezy' | 'paddle' | 'custom',

  // ── Demo / CI key ───────────────────────────────────────────────────────────
  // Activating this key in dev mode creates a local 30-day token without
  // hitting the server — safe for automated tests and first-launch demos.
  demoKey: 'RUANJIAN-DEMO-2026',

  // ── Plans & payment methods (Ticket 28) ─────────────────────────────────────
  plans:          PLANS,
  paymentMethods: PAYMENT_METHODS,
  // How often the client polls /order-status while a payment is pending.
  orderPollIntervalMs: 3_000,
  orderPollTimeoutMs:  10 * 60_000,

  // ── Free trial (Ticket 33) ──────────────────────────────────────────────────
  trial: {
    durationDays: 7,
    // How often the background timer retries syncing an unsynced/local-only
    // trial with the backend (e.g. after a fully-offline first launch).
    syncIntervalHours: 6,
  },
} as const

/** True when no LICENSE_SIGNING_SECRET override was supplied — see the warning this drives in index.ts. */
export const usingDefaultSigningSecret = LICENSE_CONFIG.signingSecret === DEFAULT_SIGNING_SECRET
