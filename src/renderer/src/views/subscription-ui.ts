import type { PaymentMethod, PaymentMethodInfo, PlanId } from '../store/subscription-types'

// Display fallback for a payment method's badge. Used in three places that
// never go through the live /payment-methods list: rendering a *historical*
// order row whose method may no longer be offered, filling in a field an
// older/newer server build omitted, and — since WIN-SYNC-02/04 — building
// the offline picker below when the live fetch fails outright.
export const METHOD_BADGE: Record<PaymentMethod, { glyph: string; color: string }> = {
  wechat_pay: { glyph: '微', color: '#07c160' },
  alipay:     { glyph: '支', color: '#1677ff' },
  douyin_pay: { glyph: '抖', color: '#000000' },
  card:       { glyph: '💳', color: 'var(--accent)' },
}

// Prefers the server-supplied icon/color; falls back to METHOD_BADGE above
// when a field is missing. `color: null` (server's card entry) intentionally
// resolves to the current theme accent rather than a fixed brand hex.
export function badgeFor(method: PaymentMethodInfo): { glyph: string; color: string } {
  const fallback = METHOD_BADGE[method.id]
  return {
    glyph: method.icon || fallback?.glyph || '💳',
    color: method.color || fallback?.color || 'var(--accent)',
  }
}

/**
 * The payment methods to show in the picker.
 *
 * WIN-SYNC-02/04: the picker must always be there to click, so a failed or
 * empty live /payment-methods fetch degrades to the build's static method
 * list (LicenseConfig.paymentMethods) rendered with local labels and badges,
 * instead of collapsing the payment step to a "temporarily unavailable"
 * notice. Availability is re-checked server-side when the order is created,
 * so an offline-listed method that turns out to be disabled fails there —
 * with a real error — rather than by being silently missing from the UI.
 *
 * `live` always wins when it is non-empty: it is the only source that knows
 * what is actually enabled right now.
 */
export function resolvePaymentMethods(
  live: PaymentMethodInfo[],
  fallbackIds: readonly PaymentMethod[],
  label: (id: PaymentMethod) => string,
): PaymentMethodInfo[] {
  if (live.length > 0) return live
  return fallbackIds
    .filter((id) => id in METHOD_BADGE)
    .map((id) => ({
      id,
      enabled: true,
      name: label(id),
      icon: METHOD_BADGE[id].glyph,
      color: METHOD_BADGE[id].color,
    }))
}

export type CheckoutBlocker = 'plan' | 'method' | null

/**
 * What (if anything) stops checkout from starting right now.
 *
 * WIN-SYNC-02/04: the Pay button stays clickable at all times — including
 * while the license token is invalid — so this reports what to *tell* the
 * user rather than what to disable. License state is deliberately not an
 * input: an unlicensed/invalid user is exactly who needs to buy, and the
 * only authorization that matters happens server-side when the order is
 * created.
 */
export function checkoutBlocker(
  selectedPlan: PlanId | null,
  selectedMethod: PaymentMethod | null,
): CheckoutBlocker {
  if (!selectedPlan)   return 'plan'
  if (!selectedMethod) return 'method'
  return null
}
