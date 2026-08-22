import { describe, expect, it } from 'vitest'
import { badgeFor, checkoutBlocker, resolvePaymentMethods } from './subscription-ui'
import type { PaymentMethod, PaymentMethodInfo } from '../store/subscription-types'

const label = (id: PaymentMethod): string => `label:${id}`

const live: PaymentMethodInfo[] = [
  { id: 'wechat_pay', enabled: true, name: '微信支付', icon: '微', color: '#07c160' },
]

describe('resolvePaymentMethods', () => {
  it('uses the live list when the server returned one', () => {
    expect(resolvePaymentMethods(live, ['alipay', 'card'], label)).toEqual(live)
  })

  it('falls back to the build list so the picker is never empty', () => {
    const resolved = resolvePaymentMethods([], ['card', 'wechat_pay', 'alipay'], label)
    expect(resolved.map((m) => m.id)).toEqual(['card', 'wechat_pay', 'alipay'])
    expect(resolved.every((m) => m.enabled)).toBe(true)
    expect(resolved[0].name).toBe('label:card')
  })

  it('gives every fallback entry a badge to render', () => {
    for (const method of resolvePaymentMethods([], ['card', 'wechat_pay', 'alipay', 'douyin_pay'], label)) {
      const badge = badgeFor(method)
      expect(badge.glyph).not.toBe('')
      expect(badge.color).not.toBe('')
    }
  })

  it('drops ids this build has no badge for rather than rendering a blank chip', () => {
    const resolved = resolvePaymentMethods([], ['card', 'paypal' as PaymentMethod], label)
    expect(resolved.map((m) => m.id)).toEqual(['card'])
  })

  it('returns nothing when there is no live list and nothing to fall back to', () => {
    expect(resolvePaymentMethods([], [], label)).toEqual([])
  })
})

describe('badgeFor', () => {
  it('prefers the server-supplied icon and color', () => {
    expect(badgeFor({ id: 'card', enabled: true, name: 'Card', icon: '🏦', color: '#123456' }))
      .toEqual({ glyph: '🏦', color: '#123456' })
  })

  it('resolves a null color to the theme accent', () => {
    expect(badgeFor({ id: 'card', enabled: true, name: 'Card', icon: '', color: null }).color)
      .toBe('var(--accent)')
  })
})

describe('checkoutBlocker', () => {
  it('reports the plan first, then the method', () => {
    expect(checkoutBlocker(null, null)).toBe('plan')
    expect(checkoutBlocker(null, 'alipay')).toBe('plan')
    expect(checkoutBlocker('annual', null)).toBe('method')
  })

  it('clears once both are chosen', () => {
    expect(checkoutBlocker('annual', 'alipay')).toBeNull()
  })
})
