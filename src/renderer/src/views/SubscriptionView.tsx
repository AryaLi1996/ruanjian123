import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { BrandLogo } from '../components/brand/BrandLogo'
import type {
  ActivationResult,
  LicenseConfig,
  PaymentMethod,
  PaymentMethodInfo,
  PaymentOrder,
  PaymentHistoryEntry,
  PlanId,
} from '../store/subscription-types'

async function openManageCheckout(): Promise<void> {
  const { checkoutUrl } = await window.engine.getLicenseConfig()
  if (!checkoutUrl) return
  window.open(checkoutUrl, '_blank', 'noopener,noreferrer')
}

// Display fallback only — the live picker gets its name/icon/color straight
// from the server (see PaymentMethodInfo / getPaymentMethods), which is now
// the source of truth. This stays around for two cases that never go
// through that live list: rendering a *historical* order/payment-history
// row whose method may no longer be in the currently-available set, and a
// defensive fallback if an older/newer server build ever omits a field.
const METHOD_BADGE: Record<PaymentMethod, { glyph: string; color: string }> = {
  wechat_pay: { glyph: '微', color: '#07c160' },
  alipay:     { glyph: '支', color: '#1677ff' },
  douyin_pay: { glyph: '抖', color: '#000000' },
  card:       { glyph: '💳', color: 'var(--accent)' },
}

// Prefers the server-supplied icon/color; falls back to METHOD_BADGE above
// when a field is missing. `color: null` (server's card entry) intentionally
// resolves to the current theme accent rather than a fixed brand hex.
function badgeFor(method: PaymentMethodInfo): { glyph: string; color: string } {
  const fallback = METHOD_BADGE[method.id]
  return {
    glyph: method.icon || fallback?.glyph || '💳',
    color: method.color || fallback?.color || 'var(--accent)',
  }
}

type OrderPhase = 'idle' | 'creating' | 'pending' | 'success' | 'error'

function formatAmount(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() })
      .format(amount / 100)
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`
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
  const [checkoutReady, setCheckoutReady] = useState(false)

  const [config, setConfig] = useState<LicenseConfig | null>(null)
  const [selectedPlan,   setSelectedPlan]   = useState<PlanId>('monthly')

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
    window.engine.getLicenseConfig()
      .then((cfg) => {
        setCheckoutReady(Boolean(cfg.checkoutUrl))
        setConfig(cfg)
      })
      .catch(() => setCheckoutReady(false))
  }, [])

  // A fetch failure and a genuinely-empty response are both treated as "no
  // methods available right now" — same friendly notice + retry either way
  // (see render below), since the user has no way to tell those apart and
  // neither should look like a broken app.
  const loadMethods = useCallback(() => {
    setMethodsLoading(true)
    window.engine.getPaymentMethods(i18n.language)
      .then((list) => {
        setMethods(list)
        // Keep the current selection if it's still offered; otherwise
        // auto-select when there's exactly one option (skips the picker
        // entirely, see render below) and clear it when there are none/many.
        setSelectedMethod((prev) =>
          (prev && list.some((m) => m.id === prev) ? prev : (list.length === 1 ? list[0].id : null)))
      })
      .catch(() => setMethods([]))
      .finally(() => setMethodsLoading(false))
  }, [i18n.language])

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

  async function handleSubscribe(): Promise<void> {
    if (!selectedMethod) return
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
      if (res.success) setSuccess('✓ License activated! All features unlocked.')
      else             setError(res.error ?? 'Activation failed')
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
                <strong>{t(`subscription.${payload.planId}`)}</strong>
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
            <button
              className="btn btn-primary"
              onClick={openManageCheckout}
              disabled={!checkoutReady}
            >
              {checkoutReady ? t('subscription.manage') : t('common.paymentUnavailable')}
            </button>
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
      {(status === 'unlicensed' || status === 'expired' || status === 'grace_period' || status === 'active') && (
        <div className="card">
          <div className="card-title">
            {status === 'unlicensed' ? t('subscription.activateTitle') : t('subscription.renewTitle')}
          </div>

          {orderPhase === 'idle' && config && (
            <>
              <div className="sub-plan-picker">
                <span className="sub-field-label">{t('subscription.choosePlan')}</span>
                <div className="sub-option-grid">
                  {config.plans.map((plan) => (
                    <button
                      key={plan.id}
                      type="button"
                      className={`sub-option${selectedPlan === plan.id ? ' sub-option-selected' : ''}`}
                      onClick={() => setSelectedPlan(plan.id)}
                    >
                      <strong>{t(`subscription.${plan.id}`)}</strong>
                      <span>{formatAmount(plan.amount, plan.currency, i18n.language)}</span>
                    </button>
                  ))}
                </div>
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
                  <button type="button" className="btn btn-primary sub-method-single" onClick={handleSubscribe}>
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
                        onClick={() => setSelectedMethod(method.id)}
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

              {/* The single-method case already has its own CTA above. */}
              {methods.length > 1 && (
                <button
                  className="btn btn-primary sub-checkout-btn"
                  onClick={handleSubscribe}
                  disabled={!selectedMethod}
                  style={{ marginTop: 14 }}
                >
                  💳 {t('subscription.payNow')}
                </button>
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

          {/* ── Manual key activation (legacy / email-delivered keys) ── */}
          {(status === 'unlicensed' || status === 'expired' || status === 'grace_period') && orderPhase === 'idle' && (
            <div style={{ marginTop: 20 }}>
              <label className="field" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('subscription.activateKey')}
                </span>
              </label>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <input
                  className="input"
                  placeholder={t('subscription.keyPlaceholder')}
                  value={key}
                  onChange={(e) => setKey(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                  disabled={activating}
                  style={{ flex: 1, fontFamily: 'monospace' }}
                />
                <button
                  className="btn btn-primary"
                  onClick={handleActivate}
                  disabled={activating || !key.trim()}
                  style={{ flexShrink: 0 }}
                >
                  {activating ? `⏳ ${t('subscription.activating')}` : t('common.activate')}
                </button>
              </div>
              {error   && <div className="error-banner"  style={{ marginTop: 10 }}>{error}</div>}
              {success && <div className="sub-success"   style={{ marginTop: 10 }}>{success}</div>}
              <p className="sub-demo-hint">
                {t('subscription.demo')}
              </p>
            </div>
          )}
        </div>
      )}

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
                    <td>{t(`subscription.${entry.planId}`)}</td>
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
