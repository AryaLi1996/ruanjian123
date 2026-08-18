import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import type {
  ActivationResult,
  LicenseConfig,
  PaymentMethod,
  PaymentOrder,
  PaymentHistoryEntry,
  PlanId,
} from '../store/subscription-types'

async function openManageCheckout(): Promise<void> {
  const { checkoutUrl } = await window.engine.getLicenseConfig()
  if (!checkoutUrl) return
  window.open(checkoutUrl, '_blank', 'noopener,noreferrer')
}

const METHOD_BADGE: Record<PaymentMethod, { glyph: string; color: string }> = {
  wechat_pay: { glyph: '微', color: '#07c160' },
  alipay:     { glyph: '支', color: '#1677ff' },
  douyin_pay: { glyph: '抖', color: '#000000' },
  card:       { glyph: '💳', color: 'var(--accent)' },
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

export function SubscriptionView(): JSX.Element {
  const { t, i18n } = useTranslation()
  const { status, expiresAt, daysRemaining, graceDaysLeft, payload } =
    useSubscriptionStore()

  const [key,       setKey]       = useState('')
  const [activating, setActivating] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [success,   setSuccess]   = useState<string | null>(null)
  const [checkoutReady, setCheckoutReady] = useState(false)

  const [config, setConfig] = useState<LicenseConfig | null>(null)
  const [selectedPlan,   setSelectedPlan]   = useState<PlanId>('monthly')
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod>('wechat_pay')

  const [orderPhase, setOrderPhase] = useState<OrderPhase>('idle')
  const [order,      setOrder]      = useState<PaymentOrder | null>(null)
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
        if (cfg.paymentMethods?.length) setSelectedMethod(cfg.paymentMethods[0])
      })
      .catch(() => setCheckoutReady(false))
  }, [])

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

  const checkOrder = useCallback((orderId: string) => {
    window.engine.getOrderStatus(orderId)
      .then((res) => {
        if (res.error) return // transient network hiccup — keep polling
        if (res.status === 'paid') {
          stopPolling()
          window.engine.closeEmbeddedPayment().catch(() => {})
          setOrderPhase('success')
          loadHistory()
        } else if (res.status === 'failed' || res.status === 'expired') {
          stopPolling()
          setOrderPhase('error')
          setOrderError(t('subscription.paymentFailed'))
        }
      })
      .catch(() => { /* transient — next tick will retry */ })
  }, [loadHistory, stopPolling, t])

  async function handleSubscribe(): Promise<void> {
    setOrderError(null)
    setOrderPhase('creating')
    try {
      const result = await window.engine.createPaymentOrder(selectedPlan, selectedMethod)
      if (result.error) throw new Error(result.error)
      setOrder(result)
      setOrderPhase('pending')

      if (result.presentAs === 'embedded' && result.redirectUrl) {
        await window.engine.openEmbeddedPayment(result.redirectUrl)
      } else if (result.redirectUrl) {
        window.open(result.redirectUrl, '_blank', 'noopener,noreferrer')
      }

      const intervalMs = config?.pollIntervalMs ?? 3_000
      const timeoutMs  = config?.pollTimeoutMs  ?? 600_000
      pollTimer.current   = setInterval(() => checkOrder(result.orderId), intervalMs)
      pollTimeout.current = setTimeout(() => {
        stopPolling()
        setOrderPhase('error')
        setOrderError(t('subscription.paymentTimeout'))
      }, timeoutMs)
    } catch (err) {
      setOrderPhase('error')
      setOrderError(String(err))
    }
  }

  function handleCancelOrder(): void {
    stopPolling()
    window.engine.closeEmbeddedPayment().catch(() => {})
    setOrderPhase('idle')
    setOrder(null)
    setOrderError(null)
  }

  function handleRetry(): void {
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
    <>
      <div className="view-header">
        <h1 className="view-title">{t('subscription.title')}</h1>
        <p className="view-desc">{t('subscription.description')}</p>
      </div>

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
                <div className="sub-option-grid">
                  {config.paymentMethods.map((method) => (
                    <button
                      key={method}
                      type="button"
                      className={`sub-option${selectedMethod === method ? ' sub-option-selected' : ''}`}
                      onClick={() => setSelectedMethod(method)}
                    >
                      <span className="sub-method-badge" style={{ background: METHOD_BADGE[method].color }}>
                        {METHOD_BADGE[method].glyph}
                      </span>
                      <span>{t(`subscription.method.${method}`)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <button className="btn btn-primary sub-checkout-btn" onClick={handleSubscribe} style={{ marginTop: 14 }}>
                💳 {t('subscription.payNow')}
              </button>
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
    </>
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
