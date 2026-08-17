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

export const LICENSE_CONFIG = {
  // ── Serverless verification endpoint ───────────────────────────────────────
  // Replace with your actual deployed URL.
  // Set VITE_LICENSE_URL (renderer) or LICENSE_URL (main) env var in production.
  verificationUrl: process.env['LICENSE_URL'] ??
    'https://5pmjnezmzrbjw2tjmnzpt232xy0duvyr.lambda-url.us-east-1.on.aws/',

  // ── HMAC signing secret (shared with serverless function) ──────────────────
  // In production: use RSA – server signs with private key, app verifies with
  // public key embedded here.  For HMAC (this template): rotate via app update.
  signingSecret: process.env['LICENSE_SIGNING_SECRET'] ?? DEFAULT_SIGNING_SECRET,

  // ── Payment checkout URL ────────────────────────────────────────────────────
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
} as const

/** True when no LICENSE_SIGNING_SECRET override was supplied — see the warning this drives in index.ts. */
export const usingDefaultSigningSecret = LICENSE_CONFIG.signingSecret === DEFAULT_SIGNING_SECRET
