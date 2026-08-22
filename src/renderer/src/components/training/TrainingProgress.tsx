import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '../../utils/audio'

export interface ProgressData {
  status:       'training' | 'done'
  // The final "done" message omits the per-epoch fields, so treat them as optional.
  epoch?:        number
  total_epochs?: number
  loss?:         number
  best_loss?:    number
  elapsed_sec?:  number
  percent?:      number
  device?:       string
  output_path?: string
  model_bytes?: number
}

interface Props {
  progress: ProgressData | null
  logs:     string[]
  mode:     string
  /** Ticket UI-10: kills the run. Omitted where cancellation isn't offered. */
  onCancel?:  () => void
  cancelling?: boolean
}

/**
 * Training console (Ticket UI-10).
 *
 * Progress and ETA on top, a terminal-style log underneath that follows the
 * tail, and a destructive cancel behind a confirm step.
 */
export function TrainingProgress({ progress, logs, mode, onCancel, cancelling }: Props): JSX.Element {
  const { t } = useTranslation()
  const logRef = useRef<HTMLDivElement>(null)
  // Two-step cancel (Ticket UI-10 §4): stopping a long training run is
  // destructive and unrecoverable, so the first click only arms it.
  const [confirmingCancel, setConfirmingCancel] = useState(false)

  // Follow the tail, but only while the user is already at the bottom —
  // yanking the view back down while they're reading scrollback would make
  // the log unusable exactly when they're trying to inspect it.
  const pinnedRef = useRef(true)
  useEffect(() => {
    const el = logRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [logs])

  function handleLogScroll(): void {
    const el = logRef.current
    if (!el) return
    // A few px of slack: fractional scroll heights mean scrollTop rarely
    // lands exactly on the maximum.
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const done    = progress?.status === 'done'
  const pct     = progress?.percent ?? (done ? 100 : 0)
  const elapsed = progress?.elapsed_sec ?? 0
  const eta     = pct > 1 && pct < 100 ? (elapsed / pct) * (100 - pct) : null
  const loss    = progress?.loss ?? progress?.best_loss

  return (
    <div className="tc-console">
      {/* Header row */}
      <div className="progress-header">
        <div>
          <span className="badge">{mode}</span>
          {progress?.device && (
            <span className="badge badge-dim" style={{ marginLeft: 6 }}>
              {progress.device.toUpperCase()}
            </span>
          )}
        </div>
        <div className="progress-meta">
          {progress && (
            <>
              {progress.epoch != null && progress.total_epochs != null && (
                <span>{t('training.epoch', { current: progress.epoch, total: progress.total_epochs })}</span>
              )}
              {loss != null && <span>{t('training.loss', { value: loss.toFixed(5) })}</span>}
              {eta != null && <span className="tc-eta">{t('training.eta', { value: formatDuration(eta) })}</span>}
            </>
          )}
        </div>
      </div>

      {/* Progress bar — turns green on completion (Ticket UI-10 §5) */}
      <div
        className={`progress-track${done ? ' tc-done' : ''}`}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        <span className="progress-pct">{Math.round(pct)}%</span>
      </div>

      {/* Terminal-style log */}
      <div className="tc-log" ref={logRef} onScroll={handleLogScroll} role="log" aria-label={t('training.logLabel')}>
        {logs.length === 0 ? (
          <div className="tc-log-line tc-log-muted">{t('training.waiting')}</div>
        ) : (
          logs.map((line, i) => (
            <div key={i} className={`tc-log-line${line.includes('"status":"done"') ? ' tc-log-ok' : ''}`}>
              {line}
            </div>
          ))
        )}
        {done && <div className="tc-log-line tc-log-ok tc-log-complete">✅ {t('training.completeLog')}</div>}
      </div>

      {onCancel && !done && (
        <div className="tc-actions">
          {confirmingCancel ? (
            <>
              <span className="tc-confirm-text">{t('training.cancelConfirm')}</span>
              <button
                type="button"
                className="tc-cancel-btn danger"
                onClick={onCancel}
                disabled={cancelling}
                aria-busy={cancelling || undefined}
              >
                {cancelling
                  ? <><span className="at-spinner" aria-hidden="true" /> {t('training.cancelling')}</>
                  : t('training.cancelConfirmYes')}
              </button>
              <button
                type="button"
                className="btn btn-ghost tc-keep-btn"
                onClick={() => setConfirmingCancel(false)}
                disabled={cancelling}
              >
                {t('training.cancelConfirmNo')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="tc-cancel-btn"
              onClick={() => setConfirmingCancel(true)}
            >
              {t('training.cancel')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
