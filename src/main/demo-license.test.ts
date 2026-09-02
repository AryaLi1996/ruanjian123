/**
 * The demo license, now that the service issues it.
 *
 * Until this change a 57-character string hardcoded in license-config.ts
 * minted a 30-day token locally — no service call, and nothing counting the
 * uses. The string shipped in every installer, so knowing it was never a
 * credential, and there was no "once per device" at all. What these cover is
 * the two properties moving issuance to the service bought: nothing is granted
 * without the service saying so, and a device that deletes its local record
 * does not get a second demo.
 *
 * subscription-monitor.ts reaches for `electron` (app paths, net) and for the
 * machine-bound crypto, so those three are stubbed here; everything under test
 * — the request shape, what is adopted, what is cached, and how each refusal is
 * worded — is this module's own.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getVersion: () => '0.0.0-test',
  },
  net: { request: () => { throw new Error('no network in tests') } },
}))

// Machine-bound AES in the real thing; identity here, so a cached record can
// be read back without a keychain.
vi.mock('./model-crypto', () => ({
  encryptModelBytes: async (b: Buffer) => b,
  decryptModelBytes: async (b: Buffer) => b,
}))

vi.mock('./device-id', () => ({ getDeviceId: async () => 'd'.repeat(32) }))

const monitorModule = await import('./subscription-monitor')
const {
  SubscriptionMonitor, DEMO_PLAN_ID, DEMO_ALREADY_USED, DEMO_UNAVAILABLE, createToken,
} = monitorModule
const { LICENSE_CONFIG } = await import('./license-config')

const DAY = 86400
const now = () => Math.floor(Date.now() / 1000)

type Reply = Record<string, unknown>

/** A monitor whose every server call is answered from `routes`, recording
 *  what it was asked. */
function makeMonitor(routes: Record<string, Reply | (() => Reply)>) {
  const monitor = new SubscriptionMonitor()
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  ;(monitor as unknown as { _request: unknown })._request = async (
    method: string, path: string, body?: Record<string, unknown>,
  ) => {
    calls.push({ method, path, body })
    const key = path.split('?')[0]
    const answer = routes[key]
    if (answer === undefined) throw new Error(`unreachable: ${path}`)
    return typeof answer === 'function' ? answer() : answer
  }
  return { monitor, calls }
}

/** What the service returns for a device that has a demo coming. */
function issued(expiresAt = now() + 30 * DAY, issuedAt = now()): Reply {
  return {
    success: true,
    token: createToken({
      userId: 'demo-abc', appId: LICENSE_CONFIG.appId, planId: DEMO_PLAN_ID,
      licenseKey: 'DEMO-ABC', issuedAt, expiresAt,
      features: ['training', 'synthesis', 'separation', 'cover'],
    }),
    appId: LICENSE_CONFIG.appId, planId: DEMO_PLAN_ID,
    issuedAt, expiresAt, demoDurationDays: 30,
  }
}

const spent: Reply = {
  success: false, code: DEMO_ALREADY_USED,
  error: 'this device has already used its demo for this app',
  appId: 'smoothvoice', issuedAt: now() - 40 * DAY, expiresAt: now() - 10 * DAY,
}

beforeEach(() => { userData = mkdtempSync(join(tmpdir(), 'sv-demo-')) })
afterEach(() => { rmSync(userData, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('activateDemo()', () => {
  it('unlocks everything on the service\'s word, naming the device', async () => {
    const { monitor, calls } = makeMonitor({ 'demo/activate': issued() })

    const result = await monitor.activateDemo()

    expect(result.success).toBe(true)
    expect(monitor.getState().status).toBe('active')
    expect(monitor.getState().payload?.planId).toBe(DEMO_PLAN_ID)
    // The device is named, so the service can hold the "once". appId is added
    // by _request's tagging, which is stubbed out here — license-request.test
    // covers that.
    const call = calls.find((c) => c.path === 'demo/activate')
    expect(call?.method).toBe('POST')
    expect(call?.body?.deviceId).toBeTruthy()
  })

  it('grants nothing at all when the service cannot be reached', async () => {
    // The point of the change: there is no offline path. Signing one here
    // would put back the locally minted license this replaced.
    const { monitor } = makeMonitor({})

    const result = await monitor.activateDemo()

    expect(result.success).toBe(false)
    expect(result.code).toBe(DEMO_UNAVAILABLE)
    expect(monitor.getState().payload).toBeNull()
    // Nothing was spent, so a later attempt on a working network works.
    expect((await monitor.demoStatus()).used).toBe(false)
  })

  it('is refused a second time, and the refusal survives a deleted record', async () => {
    const { monitor } = makeMonitor({ 'demo/activate': spent })

    // No local record at all — the file the old scheme would have relied on.
    const result = await monitor.activateDemo()

    expect(result.success).toBe(false)
    expect(result.code).toBe(DEMO_ALREADY_USED)
    expect(monitor.getState().payload).toBeNull()
    // And what it said is cached, so the next launch does not offer the entry
    // again even with no network.
    const { monitor: offline } = makeMonitor({})
    expect((await offline.demoStatus()).used).toBe(true)
  })

  it('adopts the window the service issued, not "now plus thirty days"', async () => {
    // handler.py's conditional put: a reinstall inside the window recovers the
    // same license without buying more time.
    const midway = issued(now() + 10 * DAY, now() - 20 * DAY)
    const { monitor } = makeMonitor({ 'demo/activate': midway })

    await monitor.activateDemo()

    expect(monitor.getState().payload?.expiresAt).toBe(midway.expiresAt)
    expect((await monitor.demoStatus()).expiresAt)
      .toBe(new Date((midway.expiresAt as number) * 1000).toISOString())
  })

  it('refuses a token the service signed for another app', async () => {
    const foreign: Reply = {
      ...issued(),
      appId: 'shuyin',
      token: createToken({
        userId: 'demo-abc', appId: 'shuyin', planId: DEMO_PLAN_ID, licenseKey: 'DEMO-ABC',
        issuedAt: now(), expiresAt: now() + 30 * DAY,
        features: ['training', 'synthesis', 'separation', 'cover'],
      }),
    }
    const { monitor } = makeMonitor({ 'demo/activate': foreign })

    const result = await monitor.activateDemo()

    expect(result.success).toBe(false)
    expect(monitor.getState().payload).toBeNull()
  })

  it('refuses a reply whose token does not verify', async () => {
    // A rewritten response, or a service signing with a secret this build
    // does not hold. Either way it is not a license.
    const { monitor } = makeMonitor({
      'demo/activate': { ...issued(), token: 'not.a.token' },
    })

    const result = await monitor.activateDemo()

    expect(result.success).toBe(false)
    expect(monitor.getState().payload).toBeNull()
  })
})

describe('demoStatus()', () => {
  it('reports a device that has never taken one as free to', async () => {
    const { monitor } = makeMonitor({
      'demo/status': { used: false, appId: LICENSE_CONFIG.appId, issuedAt: null, expiresAt: null, expired: false, demoDurationDays: 30 },
    })

    const status = await monitor.demoStatus()

    expect(status.used).toBe(false)
    expect(status.source).toBe('server')
    expect(status.expiresAt).toBeNull()
  })

  it('takes the service\'s answer over an empty local record, and caches it', async () => {
    const issuedAt = now() - 5 * DAY
    const { monitor } = makeMonitor({
      'demo/status': {
        used: true, appId: LICENSE_CONFIG.appId, issuedAt,
        expiresAt: issuedAt + 30 * DAY, expired: false, demoDurationDays: 30,
      },
    })

    const status = await monitor.demoStatus()

    expect(status.used).toBe(true)
    expect(status.source).toBe('server')
    // Cached, so an offline launch says the same thing — which is what closes
    // the hole a local-only limit left.
    const { monitor: offline } = makeMonitor({})
    const cached = await offline.demoStatus()
    expect(cached.used).toBe(true)
    expect(cached.source).toBe('local')
  })

  it('falls back to the cache rather than failing when the call does', async () => {
    const { monitor } = makeMonitor({ 'demo/activate': issued() })
    await monitor.activateDemo()

    const { monitor: offline } = makeMonitor({})
    const status = await offline.demoStatus()

    // "We cannot tell you right now" is not "you may have another one".
    expect(status.used).toBe(true)
    expect(status.source).toBe('local')
  })

  it('does not read another app\'s cached record as this app\'s demo', async () => {
    const { monitor } = makeMonitor({
      'demo/status': {
        used: true, appId: 'shuyin', issuedAt: now(), expiresAt: now() + 30 * DAY,
        expired: false, demoDurationDays: 30,
      },
    })

    // A demo spent in the sibling app on the same machine is not this app's.
    expect((await monitor.demoStatus()).used).toBe(false)
  })
})

describe('the hardcoded demo key', () => {
  it('is gone from the config entirely', () => {
    expect((LICENSE_CONFIG as Record<string, unknown>)['demoKey']).toBeUndefined()
    expect(LICENSE_CONFIG.demoDurationDays).toBe(30)
  })

  it('no longer activates anything when typed into the license box', async () => {
    // The exact string that used to work, from the deleted DEMO_LICENSE.md.
    const oldKey = 'SOOTHEVOICE-DEMO-8f3aQ9c#2b7e1D4f6a9B2c3d4e5F6a7b8C9d0e1f'
    const { monitor, calls } = makeMonitor({
      '': { valid: false, error: 'License key not found or subscription inactive' },
    })

    const result = await monitor.activate(oldKey)

    expect(result.success).toBe(false)
    expect(monitor.getState().payload).toBeNull()
    // And it went to the server like any other key, rather than being
    // recognised locally.
    expect(calls.some((c) => c.path === '')).toBe(true)
  })
})
