import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { notify } from '../store/useNotificationStore'
import { BrandLogo } from '../components/brand/BrandLogo'
import { badgeFor, checkoutBlocker, resolvePaymentMethods } from './subscription-ui'
import type {
  ActivationResult,
  LicenseConfig,
  PaymentMethod,
  PaymentMethodInfo,
  PaymentOrder,
  PaymentHistoryEntry,
  PlanId,
  PlanInfo,
} from '../store/subscription-types'

// Ticket 34: months covered by a plan, used to derive the "original"
// (pre-discount) price for the strikethrough display and the "for N
// months" charge summary. Derived from the plan's own durationDays (already
// server-supplied) rather than a second hardcoded id → months map, so a
// future plan tier needs no client change to display correctly.
function monthsFor(plan: PlanInfo): number {
  return Math.max(1, Math.round(plan.durationDays / 30))
}

// Ticket 36: plan prices are whole units (yuan or USD) already, not cents —
// force 0 fraction digits so e.g. ¥282 doesn't render as ¥282.00.
function formatPrice(price: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: currency.toUpperCase(),
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(price)
  } catch {
    return `${Math.round(price)} ${currency.toUpperCase()}`
  }
}

// Ticket 36 §4: the English UI shows the plan's USD equivalent (server- or
// fallback-computed, see PlanInfo.priceUSD); Chinese shows the real RMB
// price. Actual payment is always processed in `plan.currency` regardless of
// which one is displayed — this only ever feeds formatPrice()/the charge
// summary, never an order/payment-provider call.
function displayPrice(plan: PlanInfo, language: string): { amount: number; currency: string } {
  return language.startsWith('en')
    ? { amount: plan.priceUSD, currency: 'USD' }
    : { amount: plan.price, currency: plan.currency }
}

// Same currency selection as displayPrice(), but for the pre-discount
// "original" total shown struck through — see PlanInfo.originalPrice's doc
// comment for why this reads a plan's own originalPrice/originalPriceUSD
// rather than multiplying the monthly plan's unit price by the duration.
function displayOriginalPrice(plan: PlanInfo, language: string): { amount: number; currency: string } {
  return language.startsWith('en')
    ? { amount: plan.originalPriceUSD, currency: 'USD' }
    : { amount: plan.originalPrice, currency: plan.currency }
}

type OrderPhase = 'idle' | 'creating' | 'pending' | 'success' | 'error'

function formatAmount(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: currency.toUpperCase(),
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(amount / 100)
  } catch {
    return `${Math.round(amount / 100)} ${currency.toUpperCase()}`
  }
}

// ── Pending-order persistence ─────────────────────────────────────────────────
// SubscriptionView is remounted whenever the user switches views (Layout.tsx
// renders each view with key={activeView}), which would otherwise reset the
// in-flight order/orderPhase state to nothing. That matters most for
// 'external' methods (card/Alipay), where the user leaves the app entirely to
// pay in the system browser and may well switch views before coming back.
// Stashing the order in localStorage lets the resume-on-mount effect below
// pick the poll back up instead of silently losing track of the order.
const PENDING_ORDER_KEY = 'ruanjian.pendingOrder'

interface StoredPendingOrder { order: PaymentOrder; savedAt: number }

function savePendingOrder(order: PaymentOrder): void {
  try {
    const record: StoredPendingOrder = { order, savedAt: Date.now() }
    localStorage.setItem(PENDING_ORDER_KEY, JSON.stringify(record))
  } catch { /* localStorage unavailable — payment still works, just won't survive navigation */ }
}

function loadPendingOrder(): StoredPendingOrder | null {
  try {
    const raw = localStorage.getItem(PENDING_ORDER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredPendingOrder>
    return parsed?.order?.orderId ? (parsed as StoredPendingOrder) : null
  } catch {
    return null
  }
}

function clearPendingOrder(): void {
  try { localStorage.removeItem(PENDING_ORDER_KEY) } catch { /* ignore */ }
}

export function SubscriptionView(): JSX.Element {
  const { t, i18n } = useTranslation()
  const { status, expiresAt, daysRemaining, graceDaysLeft, payload, trial } =
    useSubscriptionStore()

  // Ticket 33: shown above the status card. Hidden once actually subscribed
  // (active/grace_period) — a subscribed user has no use for trial messaging.
  const subscribed = status === 'active' || status === 'grace_period'
  const trialBannerKey =
    !subscribed && trial.active  ? 'trial.subscription.active'  :
    !subscribed && trial.expired ? 'trial.subscription.expired' :
    null

  const [key,       setKey]       = useState('')
  const [activating, setActivating] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [success,   setSuccess]   = useState<string | null>(null)

  const [config, setConfig] = useState<LicenseConfig | null>(null)

  // ── Plan availability (Ticket 34) ─────────────────────────────────────────
  // Fetched live from the server (see getPlans) rather than assumed from the
  // static LicenseConfig.plans list, so pricing/discounts are never
  // hardcoded on the client — only falls back to the static list if the
  // live fetch fails. No plan is pre-selected: the user must explicitly
  // choose one before Subscribe is enabled (Ticket 34 §3).
  const [plans,        setPlans]        = useState<PlanInfo[]>([])
  const [plansLoading, setPlansLoading] = useState(true)
  const [selectedPlan, setSelectedPlan] = useState<PlanId | null>(null)

  // ── Payment method availability (Ticket 31) ───────────────────────────────
  // Fetched live from the server (see getPaymentMethods) rather than assumed
  // from the static LicenseConfig.paymentMethods list — only methods that
  // are actually configured/working are ever shown, so there's no disabled/
  // "unavailable" state to render in the picker below.
  const [methods,        setMethods]        = useState<PaymentMethodInfo[]>([])
  const [methodsLoading, setMethodsLoading]  = useState(true)
  const [selectedMethod, setSelectedMethod]  = useState<PaymentMethod | null>(null)

  // Lazily seeded from a pending order stashed before an earlier unmount
  // (see PENDING_ORDER_KEY above) so the UI shows "waiting for payment"
  // immediately instead of flashing back to the plan picker.
  const [orderPhase, setOrderPhase] = useState<OrderPhase>(() => (loadPendingOrder() ? 'pending' : 'idle'))
  const [order,      setOrder]      = useState<PaymentOrder | null>(() => loadPendingOrder()?.order ?? null)
  const [orderError, setOrderError] = useState<string | null>(null)

  const [history,        setHistory]        = useState<PaymentHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading]  = useState(false)

  const pollTimer   = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.engine.getLicenseConfig().then(setConfig).catch(() => {})
  }, [])

  // A fetch failure falls back to the static (offline) plan list from
  // license-config.ts rather than showing an empty grid — pricing may be
  // stale, but the user can still subscribe. `config` is set by the effect
  // above (a synchronous local IPC call), so in practice it's already
  // populated well before this network call settles.
  const loadPlans = useCallback(() => {
    setPlansLoading(true)
    window.engine.getPlans()
      .then((list) => {
        const resolved = list.length > 0 ? list : (config?.plans ?? [])
        setPlans(resolved)
        // Same pattern as loadMethods below: drop the selection if the plan
        // it pointed at is gone from the fresh list, so a stale id can never
        // leave Subscribe enabled with nothing actually selected.
        setSelectedPlan((prev) => (prev && resolved.some((p) => p.id === prev) ? prev : null))
      })
      .catch(() => setPlans(config?.plans ?? []))
      .finally(() => setPlansLoading(false))
  }, [config])

  useEffect(() => { loadPlans() }, [loadPlans])

  // WIN-SYNC-02/04: a fetch failure or an empty response falls back to the
  // build's own method list rather than replacing the picker with an
  // "unavailable" notice — the payment entry point is never allowed to
  // disappear. See resolvePaymentMethods() for why that's safe.
  const loadMethods = useCallback(() => {
    setMethodsLoading(true)
    const apply = (list: PaymentMethodInfo[]): void => {
      const resolved = resolvePaymentMethods(
        list,
        config?.paymentMethods ?? [],
        (id) => t(`subscription.method.${id}`),
      )
      setMethods(resolved)
      // Keep the current selection if it's still offered; otherwise
      // auto-select when there's exactly one option (skips the picker
      // entirely, see render below) and clear it when there are none/many.
      setSelectedMethod((prev) =>
        (prev && resolved.some((m) => m.id === prev) ? prev : (resolved.length === 1 ? resolved[0].id : null)))
    }
    window.engine.getPaymentMethods(i18n.language)
      .then(apply)
      .catch(() => apply([]))
      .finally(() => setMethodsLoading(false))
  }, [i18n.language, config, t])

  // Re-fetch when the user switches the app language (Settings) so the
  // picker's server-supplied names stay in sync — every other string on
  // this page updates instantly via i18next, so a stale English/Chinese
  // payment-method name after a language switch would stand out.
  useEffect(() => { loadMethods() }, [loadMethods])

  const loadHistory = useCallback(() => {
    setHistoryLoading(true)
    window.engine.getPaymentHistory()
      .then((entries) => setHistory(Array.isArray(entries) ? entries : []))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false))
  }, [])

  useEffect(() => { loadHistory() }, [loadHistory])

  const stopPolling = useCallback(() => {
    if (pollTimer.current)   { clearInterval(pollTimer.current);   pollTimer.current   = null }
    if (pollTimeout.current) { clearTimeout(pollTimeout.current);  pollTimeout.current = null }
  }, [])

  useEffect(() => stopPolling, [stopPolling]) // clear timers on unmount

  // Resolves 'success' only once the server has actually attached a usable
  // license token (res.licensed) — not just status:'paid' — since a paid
  // order whose license issuance failed separately must not be shown as a
  // false success (see getOrderStatus's doc comment in subscription-monitor.ts).
  const checkOrder = useCallback((orderId: string) => {
    window.engine.getOrderStatus(orderId)
      .then((res) => {
        if (res.error) return // transient network hiccup — keep polling
        if (res.status === 'paid' && res.licensed) {
          stopPolling()
          clearPendingOrder()
          window.engine.closeEmbeddedPayment().catch(() => {})
          setOrderPhase('success')
          loadHistory()
          notify({
            category: 'subscription',
            titleKey: 'notification.payment.success.title',
            messageKey: 'notification.payment.success.message',
            action: { type: 'view', view: 'subscription' },
          })
        } else if (res.status === 'failed' || res.status === 'expired') {
          stopPolling()
          clearPendingOrder()
          setOrderPhase('error')
          setOrderError(t('subscription.paymentFailed'))
        }
        // status === 'paid' but not yet licensed: keep polling — the order
        // is paid but the app hasn't received a usable license token yet.
      })
      .catch(() => { /* transient — next tick will retry */ })
  }, [loadHistory, stopPolling, t])

  // Shared by both a fresh checkout (handleSubscribe) and resuming a pending
  // order restored from localStorage after a remount. `elapsedMs` shortens
  // the timeout by however long the order has already been waiting.
  const startPolling = useCallback((orderId: string, elapsedMs = 0) => {
    const intervalMs  = config?.pollIntervalMs ?? 3_000
    const timeoutMs   = config?.pollTimeoutMs  ?? 600_000
    const remainingMs = Math.max(timeoutMs - elapsedMs, intervalMs)
    pollTimer.current   = setInterval(() => checkOrder(orderId), intervalMs)
    pollTimeout.current = setTimeout(() => {
      stopPolling()
      clearPendingOrder()
      setOrderPhase('error')
      setOrderError(t('subscription.paymentTimeout'))
    }, remainingMs)
  }, [config, checkOrder, stopPolling, t])

  // Resume a pending order that survived a remount (e.g. the user switched
  // views mid-payment). Runs once on mount; `order`/`orderPhase` were
  // already seeded from the same stored record by the lazy useState above.
  useEffect(() => {
    const pending = loadPendingOrder()
    if (!pending) return
    const elapsedMs = Date.now() - pending.savedAt
    const timeoutMs = config?.pollTimeoutMs ?? 600_000
    if (elapsedMs >= timeoutMs) {
      clearPendingOrder()
      setOrderPhase('error')
      setOrderError(t('subscription.paymentTimeout'))
      return
    }
    checkOrder(pending.order.orderId) // immediate check in case it resolved while we were away
    startPolling(pending.order.orderId, elapsedMs)
    // Intentionally mount-only: re-running this on every config/checkOrder
    // change would restart polling with a fresh timeout each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // WeChat Pay / Douyin Pay are shown in an embedded child window (see
  // main/index.ts payment:open-embedded); if the user closes it manually
  // without paying, there's no more window to wait on, so do one last check
  // and stop spinning instead of waiting out the full poll timeout.
  useEffect(() => {
    return window.engine.onPaymentWindowClosed(() => {
      if (orderPhase !== 'pending' || !order) return
      window.engine.getOrderStatus(order.orderId)
        .then((res) => {
          if (res.status === 'paid' && res.licensed) {
            stopPolling()
            clearPendingOrder()
            setOrderPhase('success')
            loadHistory()
            notify({
              category: 'subscription',
              titleKey: 'notification.payment.success.title',
              messageKey: 'notification.payment.success.message',
              action: { type: 'view', view: 'subscription' },
            })
          } else if (res.status === 'failed' || res.status === 'expired') {
            stopPolling()
            clearPendingOrder()
            setOrderPhase('error')
            setOrderError(t('subscription.paymentFailed'))
          } else {
            stopPolling()
            clearPendingOrder()
            setOrderPhase('error')
            setOrderError(t('subscription.paymentWindowClosed'))
          }
        })
        .catch(() => {
          stopPolling()
          clearPendingOrder()
          setOrderPhase('error')
          setOrderError(t('subscription.paymentWindowClosed'))
        })
    })
  }, [order, orderPhase, stopPolling, loadHistory, t])

  // WIN-SYNC-02 §2: reachable at any time — the Pay button is never
  // disabled, so a missing choice is reported here instead of being
  // expressed as a greyed-out control. License state is not checked: an
  // unlicensed/invalid token is exactly the state a buyer is in, and the
  // order endpoint does the only authorization that counts.
  async function handleSubscribe(): Promise<void> {
    if (!selectedPlan || !selectedMethod) {
      const blocker = checkoutBlocker(selectedPlan, selectedMethod)
      setOrderError(t(blocker === 'plan' ? 'subscription.selectPlanFirst' : 'subscription.selectMethodFirst'))
      return
    }
    setOrderError(null)
    setOrderPhase('creating')
    try {
      const result = await window.engine.createPaymentOrder(selectedPlan, selectedMethod)
      if (result.error) throw new Error(result.error)
      setOrder(result)
      setOrderPhase('pending')
      savePendingOrder(result)

      if (result.presentAs === 'embedded' && result.redirectUrl) {
        await window.engine.openEmbeddedPayment(result.redirectUrl)
      } else if (result.redirectUrl) {
        window.open(result.redirectUrl, '_blank', 'noopener,noreferrer')
      }

      startPolling(result.orderId)
    } catch (err) {
      setOrderPhase('error')
      setOrderError(String(err))
    }
  }

  function handleCancelOrder(): void {
    stopPolling()
    clearPendingOrder()
    window.engine.closeEmbeddedPayment().catch(() => {})
    setOrderPhase('idle')
    setOrder(null)
    setOrderError(null)
  }

  function handleRetry(): void {
    clearPendingOrder()
    setOrderPhase('idle')
    setOrder(null)
    setOrderError(null)
  }

  async function handleActivate(): Promise<void> {
    if (!key.trim()) return
    setActivating(true); setError(null); setSuccess(null)
    try {
      const res = await window.engine.activateLicense(key.trim()) as ActivationResult
      if (res.success) {
        setSuccess(t('subscription.activateSuccess'))
        setKey('')
        // The main process pushes the new state over onLicenseStateChange,
        // but ask for a refresh too so the status card above flips out of
        // "✕ Invalid token" immediately rather than on the next poll.
        window.engine.refreshLicense().catch(() => {})
      } else {
        // WIN-SYNC-03 §2: one plain, actionable message. The server's own
        // error string is opaque/untranslated, so it never reaches the user.
        setError(t('subscription.activateInvalid'))
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setActivating(false)
    }
  }

  function showTutorialAgain(): void {
    localStorage.removeItem('ruanjian.onboardingDismissed')
    window.dispatchEvent(new Event('ruanjian:show-onboarding'))
  }

  const expiryDate = expiresAt
    ? new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(expiresAt))
    : null

  // Ticket 34: derived once per render rather than re-`find()`ing inside the
  // plan-card map / charge-summary block — cheap either way at 4 plans, but
  // this keeps each read to one lookup instead of duplicating the same scan.
  const maxPlanDiscount  = plans.reduce((max, p) => Math.max(max, p.discountPercent), 0)
  const selectedPlanInfo = plans.find((p) => p.id === selectedPlan) ?? null
  // Ticket 36 §4: computed once rather than calling displayPrice() twice
  // (amount + currency) in the charge-summary JSX below.
  const selectedPlanDisplay = selectedPlanInfo ? displayPrice(selectedPlanInfo, i18n.language) : null

  const waitingHintKey: Record<PaymentMethod, string> = {
    wechat_pay: 'subscription.waitingWechat',
    douyin_pay: 'subscription.waitingDouyin',
    alipay:     'subscription.waitingAlipay',
    card:       'subscription.waitingCard',
  }

  return (
    <div className="sub-view-root">
      {/* Faint brand watermark — Ticket 32 §6. Purely decorative, so it
          sits behind the actual content (z-index) and never intercepts
          clicks (pointer-events: none). */}
      <BrandLogo variant="simple" size={520} className="sub-watermark" />
      <div className="sub-view-content">
      <div className="view-header">
        <h1 className="view-title">{t('subscription.title')}</h1>
        <p className="view-desc">{t('subscription.description')}</p>
      </div>

      {trialBannerKey && (
        <div className={`trial-status-line${trial.expired ? ' trial-status-line-expired' : ''}`}>
          {t(trialBannerKey, { days: trial.daysRemaining })}
        </div>
      )}

      {/* ── Status card ────────────────────────────────── */}
      <div className="card">
        <div className="card-title">{t('subscription.status')}</div>
        <div className="sub-status-grid">
          <div className="sub-row">
            <span>{t('subscription.status')}</span>
            <SubStatusBadge status={status} />
          </div>
          {payload && (
            <>
              <div className="sub-row">
                <span>{t('subscription.plan')}</span>
                <strong>{t(`subscription.plans.${payload.planId}`)}</strong>
              </div>
              <div className="sub-row">
                <span>{t('subscription.validUntil')}</span>
                <strong>{expiryDate ?? '—'}</strong>
              </div>
              {status === 'active' && daysRemaining > 0 && (
                <div className="sub-row">
                  <span>{t('subscription.daysRemaining')}</span>
                  <strong className="sub-days">{daysRemaining}</strong>
                </div>
              )}
              {status === 'grace_period' && (
                <div className="sub-row">
                  <span>{t('subscription.grace')}</span>
                  <strong style={{ color: '#f59e0b' }}>{graceDaysLeft}</strong>
                </div>
              )}
              <div className="sub-row">
                <span>{t('subscription.features')}</span>
                <strong>{payload.features.join(', ')}</strong>
              </div>
            </>
          )}
        </div>

        {(status === 'active' || status === 'grace_period') && (
          <div className="row" style={{ marginTop: 16, gap: 10 }}>
            {/* Ticket 36: the "Payment page unavailable" button was removed
                here — the renewal card below (choose plan → choose payment
                method) is the only payment entry point. */}
            <button className="btn btn-ghost" onClick={() => window.engine.refreshLicense()}>
              {t('common.refresh')}
            </button>
            <button
              className="btn btn-ghost"
              style={{ color: 'var(--text-muted)', fontSize: 12 }}
              onClick={() => window.engine.deactivateLicense()}
            >
              {t('common.deactivate')}
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">{t('onboarding.showAgain')}</div>
        <button className="btn btn-ghost" onClick={showTutorialAgain}>
          {t('onboarding.showAgain')}
        </button>
      </div>

      {/* ── Plan + payment method → Subscribe / Renew ────── */}
      {/* WIN-SYNC-04: rendered for every license status, including 'invalid'
          and 'loading'. Hiding the plans/payment/activation controls behind a
          valid token locked out precisely the users who need them — an
          invalid or missing token is a reason to show the purchase path, not
          to remove it. The status card above is the only place license state
          is surfaced; authorization is checked when an order is created or a
          key is activated, never at render time. `config` is likewise not
          required to render: every value read from it has a fallback. */}
      <div className="card">
        <div className="card-title">
          {subscribed ? t('subscription.renewTitle') : t('subscription.activateTitle')}
        </div>

        {orderPhase === 'idle' && (
          <>
            <div className="sub-plan-picker">
              <span className="sub-field-label">{t('subscription.choosePlan')}</span>

              {plansLoading && (
                <div className="sub-methods-loading">
                  <div className="sub-spinner" />
                  <span>{t('subscription.plansLoading')}</span>
                </div>
              )}

              {!plansLoading && plans.length === 0 && (
                <div className="notice-banner">
                  <span>{t('subscription.plansUnavailable')}</span>
                  <button type="button" className="btn btn-ghost notice-banner-btn" onClick={loadPlans}>
                    {t('common.retry')}
                  </button>
                </div>
              )}

              {!plansLoading && plans.length > 0 && (
                <div className="sub-plan-grid">
                  {plans.map((plan) => {
                    // Ticket 36 §4: shown in RMB (zh) or its USD equivalent
                    // (en) — see displayPrice()/displayOriginalPrice().
                    // Actual billing always happens in plan.currency
                    // regardless of which one is shown.
                    const planDisplay = displayPrice(plan, i18n.language)
                    const originalDisplay = plan.discountPercent > 0 ? displayOriginalPrice(plan, i18n.language) : null
                    // "Best value" tracks whichever plan(s) carry the steepest
                    // discount, not a hardcoded 'annual' id — a future 5th
                    // tier with a bigger cut is highlighted automatically,
                    // and the client makes no pricing assumption of its own.
                    const isBestValue = maxPlanDiscount > 0 && plan.discountPercent === maxPlanDiscount
                    return (
                      <button
                        key={plan.id}
                        type="button"
                        className={`sub-plan-card${selectedPlan === plan.id ? ' sub-plan-card-selected' : ''}${isBestValue ? ' sub-plan-card-best' : ''}`}
                        onClick={() => { setSelectedPlan(plan.id); setOrderError(null) }}
                      >
                        {isBestValue && <span className="sub-plan-ribbon">{t('subscription.bestValue')}</span>}
                        <strong className="sub-plan-name">{t(`subscription.plans.${plan.id}`)}</strong>
                        <span className="sub-plan-desc">{t(`subscription.planDesc.${plan.id}`)}</span>
                        <div className="sub-plan-price-row">
                          {originalDisplay != null && (
                            <span className="sub-plan-price-original">
                              {formatPrice(originalDisplay.amount, originalDisplay.currency, i18n.language)}
                            </span>
                          )}
                          <span className="sub-plan-price-final">
                            {formatPrice(planDisplay.amount, planDisplay.currency, i18n.language)}
                          </span>
                        </div>
                        {plan.discountPercent > 0 && (
                          <span className="sub-plan-discount-badge">
                            {t('subscription.discountBadge', { percent: plan.discountPercent })}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="sub-method-picker">
              <span className="sub-field-label">{t('subscription.choosePayment')}</span>

              {methodsLoading && (
                <div className="sub-methods-loading">
                  <div className="sub-spinner" />
                  <span>{t('subscription.methodsLoading')}</span>
                </div>
              )}

              {!methodsLoading && methods.length === 0 && (
                <div className="notice-banner">
                  <span>{t('subscription.methodsUnavailable')}</span>
                  <button type="button" className="btn btn-ghost notice-banner-btn" onClick={loadMethods}>
                    {t('common.retry')}
                  </button>
                </div>
              )}

              {/* Exactly one method available: skip the selection step
                  entirely — a single large, direct CTA (Ticket 31 §2/§4). */}
              {!methodsLoading && methods.length === 1 && (
                <button
                  type="button"
                  className="btn btn-primary sub-method-single"
                  onClick={handleSubscribe}
                >
                  <span className="sub-method-badge" style={{ background: badgeFor(methods[0]).color }}>
                    {badgeFor(methods[0]).glyph}
                  </span>
                  {t('subscription.payWith', { method: methods[0].name })}
                </button>
              )}

              {!methodsLoading && methods.length > 1 && (
                <div className="sub-method-grid">
                  {methods.map((method) => (
                    <button
                      key={method.id}
                      type="button"
                      className={`sub-method-card${selectedMethod === method.id ? ' sub-method-card-selected' : ''}`}
                      onClick={() => { setSelectedMethod(method.id); setOrderError(null) }}
                    >
                      <span className="sub-method-badge" style={{ background: badgeFor(method).color }}>
                        {badgeFor(method).glyph}
                      </span>
                      <span>{method.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Ticket 34 §3 / Ticket 36 §4: total due, shown once a plan is
                picked — regardless of the method picker's single-CTA vs.
                grid shape. Shown in RMB or its USD equivalent per language;
                the actual charge is always in selectedPlanInfo.currency. */}
            {selectedPlanInfo && selectedPlanDisplay && (
              <p className="sub-charge-summary">
                {t('subscription.chargeSummary', {
                  amount: formatPrice(selectedPlanDisplay.amount, selectedPlanDisplay.currency, i18n.language),
                  period: t('subscription.periodMonths', { count: monthsFor(selectedPlanInfo) }),
                })}
              </p>
            )}

            {/* The single-method case already has its own CTA above; every
                other case (including "no methods listed") gets this one.
                WIN-SYNC-02 §2: never disabled — clicking without a choice
                made explains what's missing (see handleSubscribe), which
                beats a greyed-out button that explains nothing. The label
                carries the amount due once a plan is picked. */}
            {methods.length !== 1 && (
              <button
                className="btn btn-primary sub-checkout-btn"
                onClick={handleSubscribe}
                style={{ marginTop: 14 }}
              >
                💳 {selectedPlanDisplay
                  ? t('subscription.payNowAmount', {
                      amount: formatPrice(selectedPlanDisplay.amount, selectedPlanDisplay.currency, i18n.language),
                    })
                  : t('subscription.payNow')}
              </button>
            )}

            {/* handleSubscribe's "choose a plan/method first" hint — the
                order stays in the 'idle' phase, so it isn't covered by the
                'error'-phase block further down. */}
            {orderError && (
              <div className="error-banner" style={{ marginTop: 10 }}>{orderError}</div>
            )}
          </>
        )}

        {orderPhase === 'creating' && (
          <div className="sub-order-status">
            <div className="sub-spinner" />
            <p>{t('subscription.creatingOrder')}</p>
          </div>
        )}

        {orderPhase === 'pending' && order && (
          <div className="sub-order-status">
            <div className="sub-spinner" />
            <p>{t('subscription.waitingPayment')}</p>
            <p className="sub-cta-desc">{t(waitingHintKey[order.method])}</p>
            <p className="sub-cta-desc">
              {formatAmount(order.amount, order.currency, i18n.language)} · {t(`subscription.method.${order.method}`)}
            </p>
            <button className="btn btn-ghost" onClick={handleCancelOrder}>
              {t('subscription.cancelPayment')}
            </button>
          </div>
        )}

        {orderPhase === 'success' && (
          <div className="sub-order-status">
            <div className="sub-success">{t('subscription.paymentSuccess')}</div>
            <button className="btn btn-ghost" onClick={handleRetry} style={{ marginTop: 10 }}>
              {t('common.done')}
            </button>
          </div>
        )}

        {orderPhase === 'error' && (
          <div className="sub-order-status">
            <div className="error-banner">{orderError}</div>
            <button className="btn btn-primary" onClick={handleRetry} style={{ marginTop: 10 }}>
              {t('subscription.tryAgain')}
            </button>
          </div>
        )}

        {/* ── Manual key activation (legacy / email-delivered keys) ──
            WIN-SYNC-03: sits under the payment area behind a divider, and
            — like the plan/payment controls above — is offered for every
            license status. A user holding a key bought elsewhere reaches
            this page precisely *because* the current token is invalid.
            Hidden only while an order is in flight, so the two paths can't
            race each other. */}
        {orderPhase === 'idle' && (
          <div className="sub-activation">
            <div className="sub-activation-divider" />
            <span className="sub-field-label">{t('subscription.activateKey')}</span>
            <div className="sub-activation-row">
              <input
                className="input sub-activation-input"
                placeholder={t('subscription.keyPlaceholder')}
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                disabled={activating}
                aria-label={t('subscription.activateKey')}
              />
              {/* Secondary (outlined) next to the filled Pay button above,
                  so the two never compete for the same emphasis. */}
              <button
                className="btn btn-ghost sub-activate-btn"
                onClick={handleActivate}
                disabled={activating || !key.trim()}
              >
                {activating ? `⏳ ${t('subscription.activating')}` : t('common.activate')}
              </button>
            </div>
            {error   && <div className="error-banner"  style={{ marginTop: 10 }}>{error}</div>}
            {success && <div className="sub-success"   style={{ marginTop: 10 }}>{success}</div>}
          </div>
        )}
      </div>

      {/* ── Payment history ───────────────────────────────── */}
      <div className="card">
        <div className="card-title row" style={{ justifyContent: 'space-between' }}>
          <span>{t('subscription.historyTitle')}</span>
          <button className="btn btn-ghost" onClick={loadHistory} disabled={historyLoading}>
            {t('common.refresh')}
          </button>
        </div>
        {history.length === 0 ? (
          <p className="sub-cta-desc">{t('subscription.historyEmpty')}</p>
        ) : (
          <div className="sub-history-table-wrap">
            <table className="sub-history-table">
              <thead>
                <tr>
                  <th>{t('subscription.historyDate')}</th>
                  <th>{t('subscription.historyPlan')}</th>
                  <th>{t('subscription.historyMethod')}</th>
                  <th>{t('subscription.historyAmount')}</th>
                  <th>{t('subscription.historyStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.orderId}>
                    <td>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(entry.createdAt * 1000))}</td>
                    <td>{t(`subscription.plans.${entry.planId}`)}</td>
                    <td>{t(`subscription.method.${entry.method}`)}</td>
                    <td>{formatAmount(entry.amount, entry.currency, i18n.language)}</td>
                    <td><OrderStatusBadge status={entry.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

function SubStatusBadge({ status }: { status: string }): JSX.Element {
  const { t } = useTranslation()
  const map: Record<string, [string, string]> = {
    loading:      ['var(--text-muted)',  t('common.loading')],
    unlicensed:   ['var(--text-muted)',  t('subscription.unlicensed')],
    active:       ['var(--success)',     t('subscription.active')],
    grace_period: ['#f59e0b',           t('subscription.grace')],
    expired:      ['var(--danger)',      t('subscription.expired')],
    invalid:      ['var(--danger)',      t('subscription.invalid')],
  }
  const [color, label] = map[status] ?? ['var(--text-muted)', status]
  return <strong style={{ color }}>{label}</strong>
}

function OrderStatusBadge({ status }: { status: string }): JSX.Element {
  const { t } = useTranslation()
  const map: Record<string, [string, string]> = {
    pending: ['var(--text-muted)', t('subscription.orderStatus.pending')],
    paid:    ['var(--success)',    t('subscription.orderStatus.paid')],
    failed:  ['var(--danger)',     t('subscription.orderStatus.failed')],
    expired: ['var(--danger)',     t('subscription.orderStatus.expired')],
  }
  const [color, label] = map[status] ?? ['var(--text-muted)', status]
  return <strong style={{ color }}>{label}</strong>
}
