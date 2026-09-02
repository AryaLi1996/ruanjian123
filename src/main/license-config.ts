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

// ── Rotating the signing secret ───────────────────────────────────────────────
// The secret this build *also* accepts a token from, and never signs with.
//
// Rotating an HMAC secret is not like rotating a password: both ends hold the
// same string, so the moment the service starts signing with a new one, every
// token already in a customer's hands stops verifying. To this app that reads
// as a license that was revoked — grace period, then lockout — for people
// whose subscription is perfectly current, and the only way out is an update
// they have not installed yet.
//
// So a rotation runs in two steps. First ship a build that accepts both, and
// wait for it to reach people. Then let the service switch which one it signs
// with: an old token still verifies here, and the next refresh exchanges it
// for one signed with the new secret. Once those have all been swapped or
// expired, a later build drops this.
//
// Empty means "one secret", which is the normal state — this is set only
// while a rotation is in flight. See docs/LICENSE_INFRASTRUCTURE.md §4.1.
const PREVIOUS_SIGNING_SECRET = (process.env['PREVIOUS_LICENSE_SIGNING_SECRET'] ?? '').trim()

// ── Multi-channel payment (Ticket 28) ─────────────────────────────────────────
// One payment = one order = license extended by that plan's duration.
// This is independent of Stripe's own "subscription" object — the source of
// truth for expiry is our own signed license token, not Stripe billing state.
// ── Application identity (Ticket 65b) ─────────────────────────────────────────
// The shared License service (Ticket 65a) hosts more than one product, so every
// request has to say *which* app it is talking about: a subscription bought in
// SootheVoice must unlock SootheVoice only, and the watermark-removal app's
// trial/subscription must not leak into this one (and vice versa).
//
// The value is contractual — it has to match exactly what the server and the
// other client use, so it is recorded once in docs/LICENSE_INFRASTRUCTURE.md
// and read from here everywhere else. VITE_APP_ID (the name the ticket
// specifies, kept so the same variable works for a renderer-side build) or
// APP_ID can override it at build time; anything blank falls back to the
// default rather than sending an empty appId the server would reject.
const DEFAULT_APP_ID = 'smoothvoice'

export const APP_ID: string =
  process.env['VITE_APP_ID']?.trim() || process.env['APP_ID']?.trim() || DEFAULT_APP_ID

export type PaymentMethod = 'wechat_pay' | 'alipay' | 'douyin_pay' | 'card'

// ── Multi-period plans (Ticket 34, pricing updated by Ticket 36) ──────────────
// Four billing periods, each a discount off the per-month base rate:
// monthly 0%, quarterly 5%, semi-annual 10%, annual 15%.
export type PlanId     = 'monthly' | 'quarterly' | 'semi_annual' | 'annual'
export type PlanPeriod = 'month' | 'quarter' | 'half_year' | 'year'

export interface PlanDef {
  id:                PlanId
  period:            PlanPeriod
  durationDays:      number
  discountPercent:   number
  price:             number   // major units (e.g. yuan) — display/reference only
  priceUSD:          number   // display-only USD equivalent (Ticket 36) — never used for billing
  originalPrice:     number   // pre-discount reference total (same currency as `price`) — for the strikethrough price
  originalPriceUSD:  number   // display-only USD equivalent of originalPrice (Ticket 36)
  amount:            number   // minor currency units (e.g. fen for CNY, cents for USD)
  currency:          string   // ISO 4217, lowercase — must match the serverless PLAN config
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
  // Computed the same single-rounding-step way as `price`/`priceUSD` rather
  // than derived by multiplying the monthly plan's own (already-rounded)
  // unit price by `months` — see handler.py's _build_plans() doc comment for
  // why that would drift a dollar or two from the discount% badge.
  const originalPrice = _planPrice(months, 0)
  return {
    id, period, durationDays, discountPercent, price,
    priceUSD:         _planPriceUSD(price),
    originalPrice,
    originalPriceUSD: _planPriceUSD(originalPrice),
    amount:           Math.round(price * 100),
    currency:         _FALLBACK_CURRENCY,
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
  // ── Application id sent with every License API request (Ticket 65b) ────────
  appId: APP_ID,

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

  // Also accepted when verifying, never signed with — see the note above.
  previousSigningSecret: PREVIOUS_SIGNING_SECRET,

  // ── Payment checkout URL (legacy: static Stripe Payment Link / "Manage") ───
  checkoutUrl: process.env['CHECKOUT_URL'] ?? '',

  // ── Subscription enforcement ────────────────────────────────────────────────
  gracePeriodDays:      3,     // days after expiry before full lockout
  refreshIntervalHours: 12,   // background token refresh cadence

  // ── Provider tag (for future switch) ───────────────────────────────────────
  provider: (process.env['LICENSE_PROVIDER'] ?? 'custom') as
    'stripe' | 'lemonsqueezy' | 'paddle' | 'custom',

  // ── Demo license ─────────────────────────────────────────────────────────────
  // There is no demo *key* any more. Until this change, typing a 57-character
  // string that shipped inside this file minted a local 30-day token with
  // every paid feature, and "once" was not enforced at all. Both halves of
  // that were unenforceable: the string went out with every installer, so
  // knowing it was never a credential, and nothing counted the uses.
  //
  // The service issues it now — POST demo/activate, one per (appId, deviceId),
  // holding the record itself. See activateDemo() in subscription-monitor.ts
  // and docs/LICENSE_INFRASTRUCTURE.md §5.4. The value below is only what this
  // build falls back to for display before the service has been asked; the
  // service reports its own demoDurationDays and that answer is preferred.
  demoDurationDays: 30,

  // ── Plans & payment methods (Ticket 28) ─────────────────────────────────────
  plans:          PLANS,
  paymentMethods: PAYMENT_METHODS,
  // How often the client polls /order-status while a payment is pending.
  orderPollIntervalMs: 3_000,
  orderPollTimeoutMs:  10 * 60_000,

  // ── Free trial (Ticket 33, duration revised to 3 days by Ticket 42) ────────
  trial: {
    durationDays: 3,
    // How often the background timer retries syncing an unsynced/local-only
    // trial with the backend (e.g. after a fully-offline first launch).
    syncIntervalHours: 6,
  },
} as const

/** True when no LICENSE_SIGNING_SECRET override was supplied — see the warning this drives in index.ts. */
export const usingDefaultSigningSecret = LICENSE_CONFIG.signingSecret === DEFAULT_SIGNING_SECRET

/**
 * True while a signing-secret rotation is in flight — see the note above.
 *
 * Worth saying in both directions: accepting the outgoing secret is what stops
 * a rotation logging every current subscriber out, and it also means a token
 * signed with a leaked old secret still verifies here. It is a window to get
 * through, not a state to sit in, which is why index.ts warns about it.
 */
export const rotatingSigningSecret = LICENSE_CONFIG.previousSigningSecret !== ''
