/**
 * Subscription monitor — runs in the Electron main process.
 *
 * Token format:  base64url(header) . base64url(payload) . hmac_hex
 * Anti-tamper:   max-observed-timestamp stored locally; clock rollback → expired.
 * Grace period:  features stay active for LICENSE_CONFIG.gracePeriodDays after expiry.
 * Offline:       last valid local token is used; grace period absorbs network outages.
 */
import { createHmac, timingSafeEqual, randomUUID } from 'crypto'
import { promises as fs, existsSync }   from 'fs'
import { join }                          from 'path'
import { EventEmitter }                  from 'events'
import { app }                           from 'electron'
import { LICENSE_CONFIG, PAYMENT_METHODS, PLANS, FALLBACK_USD_EXCHANGE_RATE, type PaymentMethod, type PlanId, type PlanPeriod } from './license-config'
import { tagRequest, isAppIdMismatch, tokenAppIdMatches } from './license-request'
import { encryptModelBytes, decryptModelBytes } from './model-crypto'
import { getDeviceId } from './device-id'
import { capTrialDuration } from './trial-duration'

// ── Types ─────────────────────────────────────────────────────────────────────

export type LicenseStatus =
  | 'loading'       // initial state while reading local storage
  | 'unlicensed'    // no license on disk
  | 'active'        // valid, not expired
  | 'grace_period'  // expired but within grace window
  | 'expired'       // past grace period → features locked
  | 'invalid'       // signature mismatch or corrupt token

export interface LicensePayload {
  userId:     string
  planId:     'monthly' | 'annual' | 'trial'
  licenseKey: string
  expiresAt:  number   // Unix epoch seconds
  issuedAt:   number
  features:   string[] // ['training','synthesis','separation','cover']
  // Ticket 65b: which application this license unlocks. Optional because
  // tokens issued before the shared License service learned about appId
  // carry none — see tokenAppIdMatches() for how those are treated.
  appId?:     string
}

export interface SubscriptionState {
  status:       LicenseStatus
  payload:      LicensePayload | null
  expiresAt:    string | null          // ISO date string for UI
  graceDaysLeft: number
  daysRemaining: number
  trial:        TrialState
}

// ── Free trial (Ticket 33) ──────────────────────────────────────────────────
// Layered on top of the license-token model above rather than merged into
// it: a trial has no payment and no signed token, so it's tracked
// separately and combined with license status only at the gating layer
// (SubscriptionGate.tsx: unlocked = license active/grace_period OR trial active).
export interface TrialState {
  active:        boolean
  expired:       boolean
  trialStart:    number | null   // Unix seconds
  trialEnd:      number | null   // Unix seconds
  daysRemaining: number          // ceil; 0 when not active
  hoursRemaining: number         // ceil; used instead of daysRemaining when < 24h left
  source:        'none' | 'local' | 'server'
}

interface LocalTrialRecord {
  trialStart: number
  trialEnd:   number
  // Ticket 42: the trial length (in days) the server reported as of the last
  // successful sync — cached locally so a later fully-offline stretch caps
  // against the *last known-good server value* rather than only ever
  // trusting this build's LICENSE_CONFIG.trial.durationDays, which is what
  // let the client and server disagree (7 vs 3 days) in the first place.
  // Absent on a record created before this field existed, or on a true
  // first-launch-while-offline trial that's never reached the server.
  durationDays?: number
}

interface TrialStatusResponse {
  trialUsed:  boolean
  trialStart: number | null
  trialEnd:   number | null
  expired:    boolean
  // Ticket 42: the server's current TRIAL_DAYS — see LocalTrialRecord.durationDays.
  trialDurationDays?: number
  error?:     string
}

interface TrialActivateResponse {
  success:    boolean
  trialStart: number
  trialEnd:   number
  // Ticket 42: the server's current TRIAL_DAYS — see LocalTrialRecord.durationDays.
  trialDurationDays?: number
  error?:     string
}

const NO_TRIAL: TrialState = {
  active: false, expired: false, trialStart: null, trialEnd: null,
  daysRemaining: 0, hoursRemaining: 0, source: 'none',
}

/**
 * Ticket 65b §4: raised when the shared License service reports that a license
 * belongs to a different application (e.g. a subscription bought in the
 * watermark-removal app). Distinct from a generic verification failure so
 * callers can clear the local token and route the user to a trial/subscription
 * for *this* app rather than surfacing a retryable network-ish error.
 */
export class AppIdMismatchError extends Error {
  constructor(serverError?: string) {
    super(serverError ?? `License belongs to a different application (expected appId '${LICENSE_CONFIG.appId}')`)
    this.name = 'AppIdMismatchError'
  }
}

export interface ActivationResult {
  success: boolean
  error?:  string
  state?:  SubscriptionState
  /** Ticket 65b §4: the key is valid but issued for a different application. */
  appIdMismatch?: boolean
}

// ── Payment orders (Ticket 28) ──────────────────────────────────────────────

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'expired'

export interface PaymentOrder {
  orderId:     string
  planId:      PlanId
  method:      PaymentMethod
  status:      OrderStatus
  amount:      number
  currency:    string
  createdAt:   number
  // 'embedded': open url in an in-app Electron BrowserWindow (modal-like) —
  //             used for WeChat Pay / Douyin Pay, whose hosted pages render
  //             their own QR code when loaded from a non-mobile context.
  // 'external': open url in the system default browser — used for Alipay and
  //             card, where the user benefits from their existing session /
  //             saved autofill and a clearer trust boundary.
  presentAs?:  'embedded' | 'external'
  redirectUrl?: string
}

export interface PaymentHistoryEntry {
  orderId:   string
  planId:    PlanId
  method:    PaymentMethod
  status:    OrderStatus
  amount:    number
  currency:  string
  createdAt: number
  paidAt?:   number
}

// Ticket 31: server-computed availability + display metadata for the
// picker — see /payment-methods in handler.py. `color` is null for methods
// (card) meant to follow the app's current theme accent instead of a fixed
// brand color.
export interface PaymentMethodInfo {
  id:      PaymentMethod
  enabled: boolean
  name:    string
  icon:    string
  color:   string | null
}

// Ticket 34: server-computed plan pricing — see GET /plans in handler.py's
// _handle_get_plans(). Distinct from the static PLANS in license-config.ts,
// which is only an offline fallback used when this fetch fails.
export interface PlanInfo {
  id:                PlanId
  period:            PlanPeriod
  durationDays:      number
  discountPercent:   number
  price:             number   // major units (e.g. yuan)
  priceUSD:          number   // display-only USD equivalent (Ticket 36) — never used for billing
  originalPrice:     number   // pre-discount reference total (same currency as `price`) — for the strikethrough price
  originalPriceUSD:  number   // display-only USD equivalent of originalPrice (Ticket 36)
  currency:          string
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function b64url(s: string): string  { return Buffer.from(s).toString('base64url') }
function fromb64(s: string): string { return Buffer.from(s, 'base64url').toString() }

const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'LICENSE' }))

function _sign(data: string, secret: string = LICENSE_CONFIG.signingSecret): string {
  return createHmac('sha256', secret).update(data).digest('hex')
}

export function createToken(payload: LicensePayload): string {
  const body = b64url(JSON.stringify(payload))
  return `${HEADER}.${body}.${_sign(`${HEADER}.${body}`)}`
}

/**
 * Every secret a token may have been signed with, most recent first.
 *
 * Order matters only for speed: the current secret verifies all but the tokens
 * issued before a rotation, so trying it first means the fallback costs one
 * extra HMAC on exactly those. Signing always uses the current secret alone —
 * this app never mints a token with the outgoing one.
 */
function acceptedSecrets(): string[] {
  return [LICENSE_CONFIG.signingSecret, LICENSE_CONFIG.previousSigningSecret].filter(Boolean)
}

function _signatureMatches(data: string, sig: string, secret: string): boolean {
  try {
    // Timing-safe comparison prevents timing attacks
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(_sign(data, secret), 'hex'))
  } catch {
    // Non-hex, or a length mismatch timingSafeEqual refuses to compare.
    return false
  }
}

export function verifyToken(token: string, secret?: string): LicensePayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [hdr, body, sig] = parts

  const secrets = secret ? [secret] : acceptedSecrets()
  if (!secrets.some((s) => _signatureMatches(`${hdr}.${body}`, sig, s))) return null

  try {
    return JSON.parse(fromb64(body)) as LicensePayload
  } catch {
    return null
  }
}

/**
 * Whether this token only verifies under the *previous* secret.
 *
 * A license that is genuine but signed with the outgoing secret: still
 * honoured, and worth re-fetching, because the window in which the old secret
 * is accepted is meant to close. initialize() uses it to swap the token for
 * one signed with the current secret rather than waiting for the license to
 * lapse — otherwise the later build that drops the old secret locks this
 * person out.
 *
 * False when no rotation is in flight, and false for a forgery: a token that
 * verifies under neither secret is not a license at all.
 */
export function verifiedWithPreviousSecret(token: string): boolean {
  const previous = LICENSE_CONFIG.previousSigningSecret
  if (!previous) return false
  return verifyToken(token, LICENSE_CONFIG.signingSecret) === null
    && verifyToken(token, previous) !== null
}

// ── SubscriptionMonitor ───────────────────────────────────────────────────────

export class SubscriptionMonitor extends EventEmitter {
  private static _instance: SubscriptionMonitor | null = null
  private _state: SubscriptionState = {
    status: 'loading', payload: null, expiresAt: null,
    graceDaysLeft: 0, daysRemaining: 0, trial: NO_TRIAL,
  }
  private _timer: ReturnType<typeof setInterval> | null = null
  private _trialTimer: ReturnType<typeof setInterval> | null = null

  static getInstance(): SubscriptionMonitor {
    if (!this._instance) this._instance = new SubscriptionMonitor()
    return this._instance
  }

  // ── Paths ───────────────────────────────────────────────────────────────────
  private get _tokenPath(): string { return join(app.getPath('userData'), 'license.enc') }
  private get _tsPath():    string { return join(app.getPath('userData'), '.license_ts') }
  private get _anonIdPath(): string { return join(app.getPath('userData'), '.anon_id') }
  private get _trialPath(): string { return join(app.getPath('userData'), 'trial.enc') }

  // ── Anonymous user ID ───────────────────────────────────────────────────────
  // No account system: payments/licenses are tied to a random ID generated on
  // first use and persisted locally, per Ticket 28 §4.
  private async _getOrCreateAnonId(): Promise<string> {
    try {
      const id = (await fs.readFile(this._anonIdPath, 'utf8')).trim()
      if (id) return id
    } catch { /* not created yet */ }
    const id = randomUUID()
    await fs.writeFile(this._anonIdPath, id, { mode: 0o600 })
    return id
  }

  // ── Anti-clock-tamper ───────────────────────────────────────────────────────
  private async _maxSeenTs(): Promise<number> {
    try {
      const buf = await fs.readFile(this._tsPath)
      return Number(buf.readBigUInt64BE(0))
    } catch { return 0 }
  }

  private async _saveMaxSeenTs(now: number): Promise<void> {
    const max  = Math.max(now, await this._maxSeenTs())
    const buf  = Buffer.allocUnsafe(8)
    buf.writeBigUInt64BE(BigInt(max))
    await fs.writeFile(this._tsPath, buf)
  }

  private async _clockTampered(now: number): Promise<boolean> {
    const max = await this._maxSeenTs()
    return now < max - 60   // 60-second tolerance for NTP drift
  }

  // ── Token persistence ───────────────────────────────────────────────────────
  private async _loadToken(): Promise<string | null> {
    if (!existsSync(this._tokenPath)) return null
    try {
      const enc   = await fs.readFile(this._tokenPath)
      const plain = await decryptModelBytes(enc)
      return plain.toString('utf8')
    } catch { return null }
  }

  private async _saveToken(token: string): Promise<void> {
    const enc = await encryptModelBytes(Buffer.from(token, 'utf8'))
    await fs.writeFile(this._tokenPath, enc, { mode: 0o600 })
  }

  private async _deleteToken(): Promise<void> {
    try { await fs.unlink(this._tokenPath) } catch { /* already gone */ }
  }

  // ── State helpers ───────────────────────────────────────────────────────────
  // Note: `trial` always carries forward the last-computed trial state
  // (this._state.trial) — this method only ever describes the *license*
  // side of SubscriptionState; trial state is updated independently by
  // _syncTrial() via _setState().
  private _buildState(status: LicenseStatus, payload: LicensePayload | null, now = 0): SubscriptionState {
    const trial = this._state.trial
    if (!payload) return { status, payload: null, expiresAt: null, graceDaysLeft: 0, daysRemaining: 0, trial }
    const graceEnds   = payload.expiresAt + LICENSE_CONFIG.gracePeriodDays * 86400
    const graceDaysLeft = status === 'grace_period'
      ? Math.max(0, Math.ceil((graceEnds - now) / 86400))
      : 0
    const daysRemaining = status === 'active'
      ? Math.max(0, Math.ceil((payload.expiresAt - now) / 86400))
      : 0
    return {
      status,
      payload,
      expiresAt:    new Date(payload.expiresAt * 1000).toISOString(),
      graceDaysLeft,
      daysRemaining,
      trial,
    }
  }

  private _setState(s: SubscriptionState): void {
    this._state = s
    this.emit('state-change', s)
  }

  private _resolveStatus(payload: LicensePayload, now: number): LicenseStatus {
    const graceEnds = payload.expiresAt + LICENSE_CONFIG.gracePeriodDays * 86400
    if (now < payload.expiresAt) return 'active'
    if (now < graceEnds)         return 'grace_period'
    return 'expired'
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getState(): SubscriptionState { return this._state }

  async initialize(): Promise<void> {
    // Independent of license status: runs (and starts its own background
    // sync timer) whether or not this device ever had/has a paid license.
    await this._syncTrial()
    this._startTrialSyncTimer()

    const token = await this._loadToken()
    if (!token) { this._setState({ ...this._buildState('unlicensed', null) }); return }

    const payload = verifyToken(token)
    if (!payload) { this._setState(this._buildState('invalid', null)); return }
    // Ticket 65b §3: a token with no appId predates the shared service and is
    // accepted (the server backfills it on the next verify); one stamped for
    // another product never unlocks this app, even offline.
    if (!tokenAppIdMatches(payload.appId, LICENSE_CONFIG.appId)) {
      await this._discardForeignLicense()
      return
    }

    const now = Math.floor(Date.now() / 1000)
    if (await this._clockTampered(now)) {
      this._setState(this._buildState('expired', payload, now)); return
    }
    await this._saveMaxSeenTs(now)

    const status = this._resolveStatus(payload, now)
    this._setState(this._buildState(status, payload, now))
    this._startRefreshTimer()

    // A license signed with the outgoing secret is honoured above, but the
    // window in which that secret is accepted is meant to close. Swapping it
    // now for one signed with the current secret is what makes a rotation
    // finish on its own, instead of leaving people to be locked out by the
    // build that eventually drops the old secret. Deliberately not awaited
    // and silent on failure: the token in hand already works, so this is an
    // optimisation, and the next launch tries again. The demo key never goes
    // to the server — same reason refresh() skips it.
    if (verifiedWithPreviousSecret(token) && payload.licenseKey !== LICENSE_CONFIG.demoKey) {
      void this.refresh().catch(() => {})
    }
  }

  async activate(licenseKey: string): Promise<ActivationResult> {
    // Case-insensitive: the Settings key-entry field upper-cases whatever the
    // user types (see SubscriptionView.tsx), and the demo key documented in
    // DEMO_LICENSE.md contains mixed-case characters — compare, then store,
    // the canonical demoKey so the resulting token matches it exactly (see
    // the `refresh()` demo check below, which relies on that).
    const isDemo = licenseKey.trim().toUpperCase() === LICENSE_CONFIG.demoKey.toUpperCase()

    let token: string
    if (isDemo) {
      // The explicit demo key is local-only so packaged builds can be tested offline.
      token = createToken({
        userId:     'demo_user',
        planId:     'monthly',
        licenseKey: LICENSE_CONFIG.demoKey,
        expiresAt:  Math.floor(Date.now() / 1000) + 30 * 86400,
        issuedAt:   Math.floor(Date.now() / 1000),
        features:   ['training', 'synthesis', 'separation', 'cover'],
      })
    } else {
      try {
        token = await this._verifyWithServer(licenseKey)
      } catch (err) {
        if (err instanceof AppIdMismatchError) {
          // Nothing to clear (activation never stored a token) — just report
          // it as the distinct failure it is so the UI can say "that key is
          // for another app" rather than "verification failed".
          return { success: false, error: err.message, appIdMismatch: true }
        }
        return { success: false, error: String(err) }
      }
    }

    const payload = verifyToken(token)
    if (!payload) return { success: false, error: 'Invalid token from server' }

    await this._saveToken(token)
    const now    = Math.floor(Date.now() / 1000)
    await this._saveMaxSeenTs(now)
    const status = this._resolveStatus(payload, now)
    const state  = this._buildState(status, payload, now)
    this._setState(state)
    this._startRefreshTimer()
    return { success: true, state }
  }

  /**
   * Ticket 65b §4: removes a license that belongs to another application and
   * returns the app to `unlicensed`, which is what drives the UI back to the
   * trial / subscribe path. The trial record is untouched: a still-running
   * trial for *this* app keeps working, and a used-up one is re-activated (or
   * refused) by the server on the next _syncTrial() exactly as it would be
   * for a device that never had a license.
   */
  private async _discardForeignLicense(): Promise<void> {
    await this._deleteToken()
    this._stopRefreshTimer()
    this._setState(this._buildState('unlicensed', null))
    await this._syncTrial()
  }

  async deactivate(): Promise<void> {
    await this._deleteToken()
    this._stopRefreshTimer()
    this._setState(this._buildState('unlicensed', null))
  }

  async refresh(): Promise<void> {
    // Always re-synced, unlike the license refresh below which needs a
    // token — this is what the "Refresh" button and the periodic license
    // timer already call, so it doubles as the trial's retry path too.
    await this._syncTrial()

    const token = await this._loadToken()
    if (!token) return
    const payload = verifyToken(token)
    if (!payload) return
    if (payload.licenseKey === LICENSE_CONFIG.demoKey) return
    try {
      const fresh = await this._verifyWithServer(payload.licenseKey)
      await this._saveToken(fresh)
      const now    = Math.floor(Date.now() / 1000)
      await this._saveMaxSeenTs(now)
      const p2     = verifyToken(fresh)
      if (p2) this._setState(this._buildState(this._resolveStatus(p2, now), p2, now))
    } catch (err) {
      // Ticket 65b §4: a mismatch is permanent, so — unlike a network
      // failure — the local token must not keep unlocking this app through
      // the grace period. Drop it and fall back to unlicensed; the trial
      // state re-synced at the top of refresh() still applies, and the gate
      // shows the subscribe prompt when it doesn't.
      if (err instanceof AppIdMismatchError) { await this._discardForeignLicense(); return }
      // Network failure: rely on local token + grace period
    }
  }

  // ── Server call ─────────────────────────────────────────────────────────────
  // Every route (license verify, order creation/status, payment history) lives
  // on the same Function URL, dispatched server-side by path — see handler.py.
  // Ticket 38 §3: this had no timeout at all — a connection that stalls
  // after the TCP handshake (captive portal, firewall silently dropping
  // packets, a slow mobile connection) would leave the returned promise
  // pending indefinitely. Every caller either awaits this during startup
  // (_resolveTrial, raced by index.ts's initializeMonitorWithTimeout — but
  // that race only stops *awaiting*, it doesn't cancel the request itself,
  // so the underlying socket stayed open forever) or from a user-triggered
  // action (activate/createOrder/etc.) where a hang would spin a "loading"
  // UI forever with no way out but restarting the app.
  //
  // 15s is the default here deliberately — *not* the ticket's 5s startup
  // budget. Most callers (activate, createOrder, getPaymentHistory, ...) are
  // interactive: the user clicked something and the renderer already shows
  // its own loading state, so there's no "frozen app" risk, and a 5s cutoff
  // would turn a legitimate slow response (e.g. a cold Lambda start on
  // verify-license) into a spurious failure. Only _resolveTrial() — the one
  // call that actually runs during startup — passes the tighter 5s
  // explicitly, matching the ticket's requirement for *that* path.
  private async _request<T = unknown>(
    method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, timeoutMs = 15_000,
  ): Promise<T> {
    if (!LICENSE_CONFIG.verificationUrl) {
      throw new Error(
        'License verification URL is not configured. Set LICENSE_URL to the deployed Lambda Function URL.',
      )
    }
    // Ticket 65b: every route on the shared License service is scoped by
    // application, and tagging here rather than at each call site is what
    // makes that true of *all* of them — verify, trial/status,
    // trial/activate, create-order, order-status, payment-history, plans,
    // payment-methods — with no way for a later route to forget.
    const { path: taggedPath, body: taggedBody } = tagRequest(method, path, body, LICENSE_CONFIG.appId)

    const { net } = await import('electron')
    const base = LICENSE_CONFIG.verificationUrl.replace(/\/+$/, '')
    const req  = net.request({ method, url: `${base}/${taggedPath}` })
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        req.abort()
        reject(new Error(`Request to ${path || '/'} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      let respBody = ''
      req.on('response', (res) => {
        res.on('data', (c: Buffer) => { respBody += c.toString() })
        res.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { resolve(JSON.parse(respBody)) } catch { reject(new Error('Invalid server response')) }
        })
      })
      req.on('error', (e: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      })
      if (taggedBody !== undefined) {
        req.setHeader('Content-Type', 'application/json')
        req.write(JSON.stringify(taggedBody))
      }
      req.end()
    })
  }

  private async _verifyWithServer(licenseKey: string): Promise<string> {
    const d = await this._request('POST', '', { licenseKey, appVersion: app.getVersion() }) as
      { token?: string; valid?: boolean; error?: string; code?: string }
    if (d.token && d.valid) return d.token
    // Ticket 65b §4: a license that exists but belongs to another product is
    // not a transient failure — it will never verify here, so it's raised as
    // its own error type and the callers below drop the token and fall back
    // to the trial / subscribe path instead of retrying it forever.
    if (isAppIdMismatch(d)) throw new AppIdMismatchError(d.error)
    throw new Error(d.error ?? 'Verification failed')
  }

  // ── Free trial (Ticket 33) ──────────────────────────────────────────────────
  // Local record is plaintext JSON encrypted the same way as license.enc
  // (machine-bound AES-256-GCM, see model-crypto.ts) — not because the dates
  // are secret, but so a casual edit of the file on disk can't silently
  // extend the trial.
  private async _loadLocalTrial(): Promise<LocalTrialRecord | null> {
    if (!existsSync(this._trialPath)) return null
    try {
      const enc   = await fs.readFile(this._trialPath)
      const plain = await decryptModelBytes(enc)
      const rec   = JSON.parse(plain.toString('utf8')) as Partial<LocalTrialRecord>
      if (typeof rec.trialStart === 'number' && typeof rec.trialEnd === 'number') {
        return await this._capLocalTrialDuration({
          trialStart: rec.trialStart, trialEnd: rec.trialEnd,
          ...(typeof rec.durationDays === 'number' ? { durationDays: rec.durationDays } : {}),
        })
      }
      return null
    } catch { return null }
  }

  /**
   * Ticket 42 migration: a local trial record created back when the trial
   * duration was longer (whether that was this build's
   * LICENSE_CONFIG.trial.durationDays, or a since-lowered server TRIAL_DAYS
   * this device last synced against) must not keep granting that old
   * duration just because it predates the change. Only rewrites the file
   * when a correction is actually needed — a record already within the
   * current cap is returned unchanged. A trial still active under the new,
   * shorter cap is truncated (and will therefore read as expired if `now`
   * has already passed the capped end); one that's already lapsed under its
   * *stored* trialEnd is left alone, since it reads as expired either way.
   *
   * Caps against `rec.durationDays` (the last value the *server* reported —
   * see LocalTrialRecord.durationDays) when known, falling back to this
   * build's LICENSE_CONFIG.trial.durationDays only for a record that's never
   * synced with the server. Backend-sourced records go through the same
   * correction here as an offline-safety net, but the server's own
   * trial/status response — via _apply_trial_duration_cap() in handler.py —
   * is what actually stays authoritative once reachable.
   */
  private async _capLocalTrialDuration(rec: LocalTrialRecord): Promise<LocalTrialRecord> {
    const durationDays  = rec.durationDays ?? LICENSE_CONFIG.trial.durationDays
    const now           = Math.floor(Date.now() / 1000)
    const { window, changed } = capTrialDuration(rec, durationDays, now)
    if (!changed) return rec

    const capped: LocalTrialRecord = { ...window, durationDays }
    await this._saveLocalTrial(capped)
    return capped
  }

  private async _saveLocalTrial(rec: LocalTrialRecord): Promise<void> {
    try {
      const enc = await encryptModelBytes(Buffer.from(JSON.stringify(rec), 'utf8'))
      await fs.writeFile(this._trialPath, enc, { mode: 0o600 })
    } catch { /* best-effort — trial still works this session from memory */ }
  }

  /**
   * Reconciles local + backend trial state and returns the resolved
   * TrialState, per Ticket 33 §3:
   *   1. Backend reachable, device already has a trial there → backend's
   *      trialStart/trialEnd always wins (covers "local looked active but
   *      the backend already knows it's expired/used" — e.g. the record was
   *      created from a different install on the same hardware).
   *   2. Backend reachable, device has no trial there yet → activate it
   *      (idempotent: creates fresh on a true first launch; if a local-only
   *      trial already existed, this call is what syncs/validates it, and
   *      whatever the server returns — new or an existing record it turns
   *      out to already have — is authoritative).
   *   3. Backend unreachable → fall back to the local record, or create one
   *      if this is the very first launch and it's offline (Ticket 33 §1).
   */
  private async _resolveTrial(): Promise<{ rec: LocalTrialRecord | null; source: TrialState['source'] }> {
    const local    = await this._loadLocalTrial()
    // Captured before the `if (local) return` below — TS narrows `local`
    // itself to `never` (not `null`) in the code that follows an early
    // return on a truthy check like that, so `local?.durationDays` read
    // afterward doesn't typecheck even though it's logically fine.
    const localDurationDays = local?.durationDays
    const deviceId = await getDeviceId()

    try {
      // Ticket 38 §3: this pair is the one _request() call site that actually
      // runs during app startup (via initialize() → _syncTrial()), so it gets
      // the ticket's tighter 5s budget explicitly rather than the general
      // 15s default above — an unreachable/slow trial backend on first
      // launch should fall back to local/offline quickly, not eat most of
      // the startup timeout budget on its own.
      const status = await this._request<TrialStatusResponse>(
        'GET', `trial/status?deviceId=${encodeURIComponent(deviceId)}`, undefined, 5_000,
      )
      if (status.error) throw new Error(status.error)

      if (status.trialUsed && status.trialStart != null && status.trialEnd != null) {
        const rec = this._recordFromServer(status.trialStart, status.trialEnd, status.trialDurationDays)
        await this._saveLocalTrial(rec)
        return { rec, source: 'server' }
      }

      const activation = await this._request<TrialActivateResponse>('POST', 'trial/activate', { deviceId }, 5_000)
      if (activation.error) throw new Error(activation.error)
      const rec = this._recordFromServer(activation.trialStart, activation.trialEnd, activation.trialDurationDays)
      await this._saveLocalTrial(rec)
      return { rec, source: 'server' }
    } catch {
      // Offline, or the backend isn't configured for trials yet — use
      // whatever's local, or start a fresh local-only trial. Caps the fresh
      // trial against the last server-reported duration this device knows
      // about (local?.durationDays), falling back to this build's config
      // only when there's no prior sync to go on at all (Ticket 33 §1: a
      // true first-launch-while-offline trial).
      if (local) return { rec: local, source: 'local' }
      const now          = Math.floor(Date.now() / 1000)
      const durationDays = localDurationDays ?? LICENSE_CONFIG.trial.durationDays
      const rec: LocalTrialRecord = { trialStart: now, trialEnd: now + durationDays * 86400, durationDays }
      await this._saveLocalTrial(rec)
      return { rec, source: 'local' }
    }
  }

  /** Ticket 42: builds a LocalTrialRecord from a trial/status or trial/activate
   * response, caching trialDurationDays when the server sent one (an older
   * server build might not) so a later offline stretch caps against it —
   * see LocalTrialRecord.durationDays / _capLocalTrialDuration(). */
  private _recordFromServer(trialStart: number, trialEnd: number, durationDays: number | undefined): LocalTrialRecord {
    return { trialStart, trialEnd, ...(typeof durationDays === 'number' ? { durationDays } : {}) }
  }

  private async _computeTrialState(rec: LocalTrialRecord | null, source: TrialState['source']): Promise<TrialState> {
    if (!rec) return NO_TRIAL

    const now = Math.floor(Date.now() / 1000)
    // Reuses the same anti-rollback clock as the license flow (a rolled-back
    // system clock must not be able to keep extending a trial indefinitely).
    const tampered = await this._clockTampered(now)
    await this._saveMaxSeenTs(now)

    const expired      = tampered || now >= rec.trialEnd
    const remainingSec = Math.max(0, rec.trialEnd - now)
    return {
      active:         !expired,
      expired,
      trialStart:     rec.trialStart,
      trialEnd:       rec.trialEnd,
      daysRemaining:  expired ? 0 : Math.ceil(remainingSec / 86400),
      hoursRemaining: expired ? 0 : Math.ceil(remainingSec / 3600),
      source,
    }
  }

  private async _syncTrial(): Promise<void> {
    const { rec, source } = await this._resolveTrial()
    const trial = await this._computeTrialState(rec, source)
    this._setState({ ...this._state, trial })
  }

  // ── Background trial sync timer ─────────────────────────────────────────────
  private _startTrialSyncTimer(): void {
    this._stopTrialSyncTimer()
    const ms = LICENSE_CONFIG.trial.syncIntervalHours * 3_600_000
    this._trialTimer = setInterval(() => { void this._syncTrial() }, ms)
  }

  private _stopTrialSyncTimer(): void {
    if (this._trialTimer) { clearInterval(this._trialTimer); this._trialTimer = null }
  }

  // ── Payment orders (Ticket 28) ──────────────────────────────────────────────

  async createOrder(planId: PlanId, method: PaymentMethod): Promise<PaymentOrder> {
    const userId = await this._getOrCreateAnonId()
    const d = await this._request('POST', 'create-order', {
      planId, method, userId, appVersion: app.getVersion(),
    }) as PaymentOrder & { error?: string }
    if (d.error) throw new Error(d.error)
    return d
  }

  /**
   * Single status check — the renderer polls this on an interval (cancellable
   * by the user) rather than us holding one long-lived request open. When the
   * order has just been paid, saves and applies the new/extended license token
   * so the subscription monitor updates without an app restart.
   */
  /**
   * `licensed` tells the caller whether this call actually applied a new
   * license token, as opposed to the server merely reporting status:'paid'.
   * Those can diverge — e.g. the webhook marked the order paid but license
   * issuance failed separately, or the token it sent back doesn't verify —
   * so callers must not treat status:'paid' alone as "done"; only
   * status:'paid' *and* licensed:true means the subscription state was
   * actually updated.
   */
  async getOrderStatus(orderId: string): Promise<{ status: OrderStatus; order?: PaymentOrder; licensed: boolean }> {
    const userId = await this._getOrCreateAnonId()
    const d = await this._request(
      'GET',
      `order-status?orderId=${encodeURIComponent(orderId)}&userId=${encodeURIComponent(userId)}`,
    ) as { status: OrderStatus; order?: PaymentOrder; token?: string; error?: string }
    if (d.error) throw new Error(d.error)

    let licensed = false
    if (d.status === 'paid' && d.token) {
      const payload = verifyToken(d.token)
      if (payload) {
        await this._saveToken(d.token)
        const now    = Math.floor(Date.now() / 1000)
        await this._saveMaxSeenTs(now)
        const status = this._resolveStatus(payload, now)
        this._setState(this._buildState(status, payload, now))
        this._startRefreshTimer()
        licensed = true
      }
    }
    return { status: d.status, order: d.order, licensed }
  }

  async getPaymentHistory(): Promise<PaymentHistoryEntry[]> {
    const userId = await this._getOrCreateAnonId()
    const d = await this._request('GET', `payment-history?userId=${encodeURIComponent(userId)}`) as
      { orders?: PaymentHistoryEntry[]; error?: string }
    if (d.error) throw new Error(d.error)
    return Array.isArray(d.orders) ? d.orders : []
  }

  /**
   * Ticket 34: fetches the four billing-period plans and their server-
   * computed prices from GET /plans, so the client never hardcodes an
   * amount. Falls back to nothing on error — callers (SubscriptionView) are
   * expected to fall back to the static PLANS in license-config.ts, same
   * pattern as a getPaymentMethods() failure falling back to an empty list.
   * Defensively re-filtered against the known PlanId set, same reasoning as
   * getPaymentMethods() below: a server response naming a plan id this
   * build doesn't recognize (e.g. a newer server, older client) must not
   * reach the UI.
   */
  async getPlans(): Promise<PlanInfo[]> {
    const d = await this._request('GET', 'plans') as { plans?: Partial<PlanInfo>[]; error?: string }
    if (d.error) throw new Error(d.error)
    const known = new Set<string>(PLANS.map((p) => p.id))
    return (Array.isArray(d.plans) ? d.plans : [])
      .filter((p): p is PlanInfo =>
        Boolean(p?.id) && known.has(p.id as string) &&
        typeof p.durationDays === 'number' && typeof p.price === 'number')
      // Ticket 36: an older server build might not send priceUSD/
      // originalPrice*/ yet — derive them rather than let the English UI (or
      // the plan cards' strikethrough price) show nothing. originalPrice is
      // approximated from the fallback monthly rate here (not `price`
      // reversed via the discount%, which would reintroduce the same
      // compounded-rounding drift this field exists to avoid) — this path
      // only matters for the brief window before the server picks up the
      // matching handler.py change.
      .map((p) => {
        const priceUSD = typeof p.priceUSD === 'number' ? p.priceUSD : Math.round(p.price / FALLBACK_USD_EXCHANGE_RATE)
        const months = Math.max(1, Math.round(p.durationDays / 30))
        const fallbackMonthlyPrice = PLANS.find((fp) => fp.id === 'monthly')?.price ?? p.price
        const originalPrice = typeof p.originalPrice === 'number' ? p.originalPrice : fallbackMonthlyPrice * months
        const originalPriceUSD = typeof p.originalPriceUSD === 'number'
          ? p.originalPriceUSD
          : Math.round(originalPrice / FALLBACK_USD_EXCHANGE_RATE)
        return { ...p, priceUSD, originalPrice, originalPriceUSD }
      })
  }

  /**
   * Ticket 31: which payment methods are actually usable right now, per the
   * server's own provider-credential check (see /payment-methods in
   * handler.py) — never the static PAYMENT_METHODS list, which is just
   * "methods this build knows how to render," not "methods that work." The
   * server also owns each method's display name/icon/color (localized to
   * `lang`, e.g. the renderer's current i18n.language) so the client isn't
   * duplicating that mapping just to draw the picker.
   * Defensively re-filtered against PAYMENT_METHODS here too, so a server
   * response naming an id this build doesn't recognize can't reach the UI.
   */
  async getPaymentMethods(lang: string): Promise<PaymentMethodInfo[]> {
    const d = await this._request('GET', `payment-methods?lang=${encodeURIComponent(lang)}`) as
      { methods?: { id?: string; enabled?: boolean; name?: string; icon?: string; color?: string | null }[]; error?: string }
    if (d.error) throw new Error(d.error)
    const known = new Set<string>(PAYMENT_METHODS)
    return (Array.isArray(d.methods) ? d.methods : [])
      .filter((m): m is { id: PaymentMethod; enabled?: boolean; name?: string; icon?: string; color?: string | null } =>
        Boolean(m?.id) && m.enabled !== false && known.has(m.id as string))
      .map((m) => ({
        id:      m.id,
        enabled: true,
        name:    m.name || m.id,
        icon:    m.icon || '',
        color:   m.color ?? null,
      }))
  }

  // ── Background refresh timer ────────────────────────────────────────────────
  private _startRefreshTimer(): void {
    this._stopRefreshTimer()
    const ms = LICENSE_CONFIG.refreshIntervalHours * 3_600_000
    this._timer = setInterval(() => this.refresh(), ms)
  }

  private _stopRefreshTimer(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }
}
