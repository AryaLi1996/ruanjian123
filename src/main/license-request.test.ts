import { describe, expect, it } from 'vitest'
import { withAppId, appendAppIdParam, isAppIdMismatch, tokenAppIdMatches, tagRequest } from './license-request'
import { APP_ID, LICENSE_CONFIG } from './license-config'

const APP = 'smoothvoice'

describe('APP_ID', () => {
  it("defaults to the id agreed with the shared License service", () => {
    // No VITE_APP_ID/APP_ID override is set in the test environment, so this
    // also pins the default the shipped build uses.
    expect(APP_ID).toBe(APP)
    expect(LICENSE_CONFIG.appId).toBe(APP_ID)
  })
})

describe('withAppId()', () => {
  it('adds appId to a POST body while keeping the caller fields', () => {
    expect(withAppId({ licenseKey: 'KEY-1', appVersion: '0.1.0' }, APP))
      .toEqual({ appId: APP, licenseKey: 'KEY-1', appVersion: '0.1.0' })
  })

  it('tags a bodyless POST so no request reaches the server untagged', () => {
    expect(withAppId(undefined, APP)).toEqual({ appId: APP })
  })

  it('lets an explicit appId in the body win', () => {
    expect(withAppId({ appId: 'other-app' }, APP)).toEqual({ appId: 'other-app' })
  })
})

describe('appendAppIdParam()', () => {
  it('starts a query string on a bare route', () => {
    expect(appendAppIdParam('plans', APP)).toBe(`plans?appId=${APP}`)
  })

  it('appends to a route that already has params', () => {
    expect(appendAppIdParam('order-status?orderId=o_1&userId=u_1', APP))
      .toBe(`order-status?orderId=o_1&userId=u_1&appId=${APP}`)
  })

  it('handles the empty (root) path', () => {
    expect(appendAppIdParam('', APP)).toBe(`?appId=${APP}`)
  })

  it('is idempotent so a call site that builds its own stays correct', () => {
    const once = appendAppIdParam('plans', APP)
    expect(appendAppIdParam(once, APP)).toBe(once)
  })

  it('url-encodes the id', () => {
    expect(appendAppIdParam('plans', 'a b&c')).toBe('plans?appId=a%20b%26c')
  })
})

describe('isAppIdMismatch()', () => {
  it('matches the machine-readable code', () => {
    expect(isAppIdMismatch({ code: 'app_id_mismatch', error: 'forbidden' })).toBe(true)
    expect(isAppIdMismatch({ code: 'APP_ID_MISMATCH' })).toBe(true)
  })

  it('matches a human-readable message', () => {
    expect(isAppIdMismatch({ error: 'appId mismatch: license issued for shuyin-watermark' })).toBe(true)
    expect(isAppIdMismatch({ error: 'appId does not match this license' })).toBe(true)
  })

  it('does not fire on unrelated failures', () => {
    expect(isAppIdMismatch({ error: 'License expired' })).toBe(false)
    expect(isAppIdMismatch({ error: 'Invalid license key' })).toBe(false)
    expect(isAppIdMismatch({})).toBe(false)
    expect(isAppIdMismatch(null)).toBe(false)
  })
})

describe('tokenAppIdMatches()', () => {
  it('accepts a pre-appId token (backward compatibility)', () => {
    expect(tokenAppIdMatches(undefined, APP)).toBe(true)
    expect(tokenAppIdMatches('', APP)).toBe(true)
  })

  it('accepts this app, ignoring case and surrounding space', () => {
    expect(tokenAppIdMatches(APP, APP)).toBe(true)
    expect(tokenAppIdMatches(' SmoothVoice ', APP)).toBe(true)
  })

  it('rejects a token issued for the watermark-removal app', () => {
    expect(tokenAppIdMatches('shuyin-watermark', APP)).toBe(false)
  })
})

describe('tagRequest() — every License API route carries appId', () => {
  // The routes subscription-monitor.ts actually calls, in the shape it calls
  // them: acceptance criterion "所有 License API 请求均带 appId='smoothvoice'".
  const POSTS: [string, Record<string, unknown> | undefined][] = [
    ['',               { licenseKey: 'K', appVersion: '0.1.0' }],   // verify
    ['trial/activate', { deviceId: 'dev_1' }],
    ['create-order',   { planId: 'monthly', method: 'wechat_pay', userId: 'u_1' }],
  ]
  const GETS = [
    'trial/status?deviceId=dev_1',
    'order-status?orderId=o_1&userId=u_1',
    'payment-history?userId=u_1',
    'plans',
    'payment-methods?lang=zh',
  ]

  it.each(POSTS)('POST %s puts appId in the body, path untouched', (path, body) => {
    const tagged = tagRequest('POST', path, body, APP)
    expect(tagged.path).toBe(path)
    expect(tagged.body).toMatchObject({ appId: APP, ...(body ?? {}) })
  })

  it.each(GETS)('GET %s puts appId in the query string, body untouched', (path) => {
    const tagged = tagRequest('GET', path, undefined, APP)
    expect(tagged.path).toContain(`appId=${APP}`)
    expect(tagged.path.startsWith(path)).toBe(true)
    expect(tagged.body).toBeUndefined()
  })

  it('preserves the existing query params of a GET route', () => {
    expect(tagRequest('GET', 'order-status?orderId=o_1&userId=u_1', undefined, APP).path)
      .toBe(`order-status?orderId=o_1&userId=u_1&appId=${APP}`)
  })
})
