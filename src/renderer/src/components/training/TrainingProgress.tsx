import { useEffect, useRef } from 'react'
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
}

export function TrainingProgress({ progress, logs, mode }: Props): JSX.Element {
  const { t } = useTranslation()
  const logRef = useRef<HTMLDivElement>(null)

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  const pct     = progress?.percent ?? (progress?.status === 'done' ? 100 : 0)
  const elapsed = progress?.elapsed_sec ?? 0
  const eta     = pct > 1 && pct < 100 ? (elapsed / pct) * (100 - pct) : null
  const loss    = progress?.loss ?? progress?.best_loss

  return (
    <div>
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
              {eta != null && <span>{t('training.eta', { value: formatDuration(eta) })}</span>}
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        <span className="progress-pct">{Math.round(pct)}%</span>
      </div>

      {/* Log window */}
      <div className="train-log" ref={logRef}>
        {logs.length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>{t('training.waiting')}</span>
        ) : (
          logs.map((line, i) => (
            <div key={i} className={`log-line${line.includes('"status":"done"') ? ' log-done' : ''}`}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
