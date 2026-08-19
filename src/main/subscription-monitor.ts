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
import { encryptModelBytes, decryptModelBytes } from './model-crypto'
import { getDeviceId } from './device-id'

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

interface LocalTrialRecord { trialStart: number; trialEnd: number }

interface TrialStatusResponse {
  trialUsed:  boolean
  trialStart: number | null
  trialEnd:   number | null
  expired:    boolean
  error?:     string
}

interface TrialActivateResponse {
  success:    boolean
  trialStart: number
  trialEnd:   number
  error?:     string
}

const NO_TRIAL: TrialState = {
  active: false, expired: false, trialStart: null, trialEnd: null,
  daysRemaining: 0, hoursRemaining: 0, source: 'none',
}

export interface ActivationResult {
  success: boolean
  error?:  string
  state?:  SubscriptionState
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
  id:              PlanId
  period:          PlanPeriod
  durationDays:    number
  discountPercent: number
  price:           number   // major units (e.g. yuan)
  priceUSD:        number   // display-only USD equivalent (Ticket 36) — never used for billing
  currency:        string
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function b64url(s: string): string  { return Buffer.from(s).toString('base64url') }
function fromb64(s: string): string { return Buffer.from(s, 'base64url').toString() }

const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'LICENSE' }))

function _sign(data: string): string {
  return createHmac('sha256', LICENSE_CONFIG.signingSecret).update(data).digest('hex')
}

export function createToken(payload: LicensePayload): string {
  const body = b64url(JSON.stringify(payload))
  return `${HEADER}.${body}.${_sign(`${HEADER}.${body}`)}`
}

export function verifyToken(token: string): LicensePayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [hdr, body, sig] = parts
  const expected = _sign(`${hdr}.${body}`)
  try {
    // Timing-safe comparison prevents timing attacks
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null
  } catch {
    return null
  }
  try {
    return JSON.parse(fromb64(body)) as LicensePayload
  } catch {
    return null
  }
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

    const now = Math.floor(Date.now() / 1000)
    if (await this._clockTampered(now)) {
      this._setState(this._buildState('expired', payload, now)); return
    }
    await this._saveMaxSeenTs(now)

    const status = this._resolveStatus(payload, now)
    this._setState(this._buildState(status, payload, now))
    this._startRefreshTimer()
  }

  async activate(licenseKey: string): Promise<ActivationResult> {
    const isDemo = licenseKey === LICENSE_CONFIG.demoKey

    let token: string
    if (isDemo) {
      // The explicit demo key is local-only so packaged builds can be tested offline.
      token = createToken({
        userId:     'demo_user',
        planId:     'monthly',
        licenseKey: licenseKey,
        expiresAt:  Math.floor(Date.now() / 1000) + 30 * 86400,
        issuedAt:   Math.floor(Date.now() / 1000),
        features:   ['training', 'synthesis', 'separation', 'cover'],
      })
    } else {
      try {
        token = await this._verifyWithServer(licenseKey)
      } catch (err) {
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
    } catch {
      // Network failure: rely on local token + grace period
    }
  }

  // ── Server call ─────────────────────────────────────────────────────────────
  // Every route (license verify, order creation/status, payment history) lives
  // on the same Function URL, dispatched server-side by path — see handler.py.
  private async _request<T = unknown>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    if (!LICENSE_CONFIG.verificationUrl) {
      throw new Error(
        'License verification URL is not configured. Set LICENSE_URL to the deployed Lambda Function URL.',
      )
    }
    const { net } = await import('electron')
    const base = LICENSE_CONFIG.verificationUrl.replace(/\/+$/, '')
    const req  = net.request({ method, url: `${base}/${path}` })
    return new Promise((resolve, reject) => {
      let respBody = ''
      req.on('response', (res) => {
        res.on('data', (c: Buffer) => { respBody += c.toString() })
        res.on('end', () => {
          try { resolve(JSON.parse(respBody)) } catch { reject(new Error('Invalid server response')) }
        })
      })
      req.on('error', (e: Error) => reject(e))
      if (body !== undefined) {
        req.setHeader('Content-Type', 'application/json')
        req.write(JSON.stringify(body))
      }
      req.end()
    })
  }

  private async _verifyWithServer(licenseKey: string): Promise<string> {
    const d = await this._request('POST', '', { licenseKey, appVersion: app.getVersion() }) as
      { token?: string; valid?: boolean; error?: string }
    if (d.token && d.valid) return d.token
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
        return { trialStart: rec.trialStart, trialEnd: rec.trialEnd }
      }
      return null
    } catch { return null }
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
    const deviceId = await getDeviceId()

    try {
      const status = await this._request<TrialStatusResponse>(
        'GET', `trial/status?deviceId=${encodeURIComponent(deviceId)}`,
      )
      if (status.error) throw new Error(status.error)

      if (status.trialUsed && status.trialStart != null && status.trialEnd != null) {
        const rec = { trialStart: status.trialStart, trialEnd: status.trialEnd }
        await this._saveLocalTrial(rec)
        return { rec, source: 'server' }
      }

      const activation = await this._request<TrialActivateResponse>('POST', 'trial/activate', { deviceId })
      if (activation.error) throw new Error(activation.error)
      const rec = { trialStart: activation.trialStart, trialEnd: activation.trialEnd }
      await this._saveLocalTrial(rec)
      return { rec, source: 'server' }
    } catch {
      // Offline, or the backend isn't configured for trials yet — use
      // whatever's local, or start a fresh local-only trial.
      if (local) return { rec: local, source: 'local' }
      const now = Math.floor(Date.now() / 1000)
      const rec = { trialStart: now, trialEnd: now + LICENSE_CONFIG.trial.durationDays * 86400 }
      await this._saveLocalTrial(rec)
      return { rec, source: 'local' }
    }
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
      // Ticket 36: an older server build might not send priceUSD yet —
      // derive it from `price` rather than let the English UI show nothing.
      .map((p) => ({
        ...p,
        priceUSD: typeof p.priceUSD === 'number' ? p.priceUSD : Math.round(p.price / FALLBACK_USD_EXCHANGE_RATE),
      }))
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
