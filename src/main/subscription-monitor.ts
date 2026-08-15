/**
 * Subscription monitor — runs in the Electron main process.
 *
 * Token format:  base64url(header) . base64url(payload) . hmac_hex
 * Anti-tamper:   max-observed-timestamp stored locally; clock rollback → expired.
 * Grace period:  features stay active for LICENSE_CONFIG.gracePeriodDays after expiry.
 * Offline:       last valid local token is used; grace period absorbs network outages.
 */
import { createHmac, timingSafeEqual } from 'crypto'
import { promises as fs, existsSync }   from 'fs'
import { join }                          from 'path'
import { EventEmitter }                  from 'events'
import { app }                           from 'electron'
import { LICENSE_CONFIG }                from './license-config'
import { encryptModelBytes, decryptModelBytes } from './model-crypto'

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
}

export interface ActivationResult {
  success: boolean
  error?:  string
  state?:  SubscriptionState
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
    graceDaysLeft: 0, daysRemaining: 0,
  }
  private _timer: ReturnType<typeof setInterval> | null = null

  static getInstance(): SubscriptionMonitor {
    if (!this._instance) this._instance = new SubscriptionMonitor()
    return this._instance
  }

  // ── Paths ───────────────────────────────────────────────────────────────────
  private get _tokenPath(): string { return join(app.getPath('userData'), 'license.enc') }
  private get _tsPath():    string { return join(app.getPath('userData'), '.license_ts') }

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
  private _buildState(status: LicenseStatus, payload: LicensePayload | null, now = 0): SubscriptionState {
    if (!payload) return { status, payload: null, expiresAt: null, graceDaysLeft: 0, daysRemaining: 0 }
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
    const token = await this._loadToken()
    if (!token) return
    const payload = verifyToken(token)
    if (!payload) return
    if (payload.licenseKey === LICENSE_CONFIG.demoKey) return
    try {
      const fresh = await this._verifyWithServer(payload.licenseKey)
      await this._saveToken(fresh)
      const now    = Math.floor(Date.now() / 1000)
      const p2     = verifyToken(fresh)
      if (p2) this._setState(this._buildState(this._resolveStatus(p2, now), p2, now))
    } catch {
      // Network failure: rely on local token + grace period
    }
  }

  // ── Server call ─────────────────────────────────────────────────────────────
  private async _verifyWithServer(licenseKey: string): Promise<string> {
    if (!LICENSE_CONFIG.verificationUrl) {
      throw new Error(
        'License verification URL is not configured. Set LICENSE_URL to the deployed Lambda Function URL.',
      )
    }
    const { net } = await import('electron')
    const req     = net.request({ method: 'POST', url: LICENSE_CONFIG.verificationUrl })
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('response', (res) => {
        res.on('data', (c: Buffer) => { body += c.toString() })
        res.on('end', () => {
          try {
            const d = JSON.parse(body) as { token?: string; valid?: boolean; error?: string }
            if (d.token && d.valid) resolve(d.token)
            else reject(new Error(d.error ?? 'Verification failed'))
          } catch { reject(new Error('Invalid server response')) }
        })
      })
      req.on('error', (e: Error) => reject(e))
      req.setHeader('Content-Type', 'application/json')
      req.write(JSON.stringify({ licenseKey, appVersion: app.getVersion() }))
      req.end()
    })
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
